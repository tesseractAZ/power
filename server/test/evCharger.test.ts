import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { evLoadByHour, computeEvWindowPrediction, detectLiveEvSession, resetEvWindowCache } from '../src/analytics.js';
import { parseEvCircuits, evCircuitScanned } from '../src/limits.js';
import { makeRecorderStub } from './helpers/recorderStub.js';
import { withEnv } from './golden/support/env.js';
import type { Recorder } from '../src/recorder.js';
import type { DeviceSnapshot } from '../src/snapshot.js';

/**
 * v1.191.0 (S9, E1–E3) — the EV options: EV_MAX_LOAD_W (the per-charger ceiling), EV_CHARGER_COUNT
 * (how overlapping predicted sessions combine; 0 = no charger), EV_PLATEAU_MIN_W (what counts as an
 * EV session) and EV_CIRCUITS (which circuits the detectors scan). Unset, each is today's behaviour:
 * one charger at 11520 W, MAX of overlapping sessions, a 6000 W plateau, every circuit (golden G8).
 */
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../src');
const MIN = 60_000;
const H = 3_600_000;
const EV_UNSET = { EV_MAX_LOAD_W: undefined, EV_CHARGER_COUNT: undefined, EV_PLATEAU_MIN_W: undefined, EV_CIRCUITS: undefined };

type Pc = { primaryCh: number; secondaryCh?: number | null };
function panelWith(circuits: Pc[]): Record<string, DeviceSnapshot> {
  return {
    SHP: {
      sn: 'SHP', deviceName: 'Smart Panel', productName: 'Smart Home Panel 2', online: true, lastSeenMs: Date.now(),
      projection: { kind: 'shp2', pairedCircuits: circuits, sources: [] } as never,
    } as never,
  };
}
const recorderFor = (series: Record<string, Array<{ ts: number; value: number }>>): Recorder =>
  makeRecorderStub({ query: (_sn, metric) => series[metric] ?? [] });
function session(startMs: number, durMin: number, watts: number): Array<{ ts: number; value: number }> {
  const out: Array<{ ts: number; value: number }> = [];
  for (let m = 0; m <= durMin; m += 5) out.push({ ts: startMs + m * MIN, value: watts });
  out.push({ ts: startMs + (durMin + 5) * MIN, value: 0 });
  return out;
}
/** Sessions on scattered past days, so they are observed without forming a recurrence pattern. */
function scattered(watts: number): Array<{ ts: number; value: number }> {
  const now = Date.now();
  return [20, 13, 6].flatMap((d, i) => { const t = new Date(now - d * 24 * H); t.setHours(10 + i * 3, 0, 0, 0); return session(t.getTime(), 60, watts); })
    .sort((a, b) => a.ts - b.ts);
}
/** A live session: charging now, for 30 min. */
function live(watts: number): Array<{ ts: number; value: number }> {
  const now = Date.now();
  const out: Array<{ ts: number; value: number }> = [];
  for (let m = 30; m >= 0; m -= 5) out.push({ ts: now - m * MIN, value: watts });
  return out;
}
let seq = 0;
async function freshAnalytics(env: Record<string, string | undefined>): Promise<typeof import('../src/analytics.js')> {
  seq += 1;
  return withEnv({ ...EV_UNSET, ...env }, async () => (await import(`${pathToFileURL(resolve(SRC, 'analytics.ts')).href}?ev=${seq}`)) as typeof import('../src/analytics.js'));
}

/* ── E2: how overlapping predicted sessions combine ───────────────────────────────────────── */

const overlapping = [
  { ts: 0, durationHours: 2, watts: 7000 },
  { ts: 0, durationHours: 1, watts: 9000 },
  { ts: H, durationHours: 1, watts: 6000 },
];

test('★ one charger (the default): overlapping sessions are alternatives — each hour takes the MAX', () => {
  const m = evLoadByHour(overlapping, 11_520, 1);
  assert.equal(m.get(0), 9000);
  assert.equal(m.get(1), 7000);
  assert.deepEqual([...evLoadByHour(overlapping)], [...m], 'unset reads as one charger');
  assert.deepEqual([...evLoadByHour(overlapping, 11_520, 0)], [...m], 'no charger keeps the MAX combination (the detectors find nothing)');
});

test('★ EV_CHARGER_COUNT 2: overlapping sessions add up, capped at count × the per-charger maximum', () => {
  const m = evLoadByHour(overlapping, 11_520, 2);
  assert.equal(m.get(0), 16_000);
  assert.equal(m.get(1), 13_000);
  const capped = evLoadByHour([{ ts: 0, durationHours: 1, watts: 11_000 }, { ts: 0, durationHours: 1, watts: 11_000 }, { ts: 0, durationHours: 1, watts: 11_000 }], 11_520, 2);
  assert.equal(capped.get(0), 2 * 11_520, 'three sessions on two chargers stop at two chargers\' worth');
  const weighted = evLoadByHour([{ ts: 0, durationHours: 1, watts: 10_000, probability: 0.5 }, { ts: 0, durationHours: 1, watts: 10_000, probability: 0.5 }], 11_520, 3);
  assert.equal(weighted.get(0), 10_000, 'expected-value weights add too');
});

test('★ EV_CHARGER_COUNT set reaches evLoadByHour\'s default, EV_MAX_LOAD_W its per-charger cap', async () => {
  const two = await freshAnalytics({ EV_CHARGER_COUNT: '2' });
  assert.equal(two.evLoadByHour(overlapping).get(0), 16_000);
  const capped = await freshAnalytics({ EV_MAX_LOAD_W: '7200' });
  assert.equal(capped.evLoadByHour([{ ts: 0, durationHours: 1, watts: 99_999 }]).get(0), 7200);
  const both = await freshAnalytics({ EV_MAX_LOAD_W: '7200', EV_CHARGER_COUNT: '2' });
  assert.equal(both.evLoadByHour([{ ts: 0, durationHours: 1, watts: 99_999 }, { ts: 0, durationHours: 1, watts: 99_999 }]).get(0), 14_400);
});

/* ── E3: which circuits are scanned, and what counts as an EV session ─────────────────────── */

test('parseEvCircuits: channels 1..12, comma-separated; nothing valid scans every circuit', () => {
  assert.deepEqual([...parseEvCircuits('11, 12')!], [11, 12]);
  assert.deepEqual([...parseEvCircuits('3,3,x,13,0,-1,4')!], [3, 4]);
  assert.equal(parseEvCircuits(undefined), null);
  assert.equal(parseEvCircuits(''), null);
  assert.equal(parseEvCircuits('none of them'), null);
  assert.equal(evCircuitScanned({ primaryCh: 11, secondaryCh: 12 }, new Set([12])), true, 'either leg of a 240 V pair');
  assert.equal(evCircuitScanned({ primaryCh: 5, secondaryCh: null }, new Set([12])), false);
  assert.equal(evCircuitScanned({ primaryCh: 5 }, null), true);
});

test('★ EV_CIRCUITS restricts the mined scan and the live-session scan to the listed circuits', async () => {
  const devices = panelWith([{ primaryCh: 5, secondaryCh: null }, { primaryCh: 9, secondaryCh: 10 }]);
  const rec = recorderFor({ pair5_w: scattered(10_500), pair9_w: scattered(10_500) });
  await withEnv({ ...EV_UNSET }, () => {
    resetEvWindowCache();
    assert.equal(computeEvWindowPrediction(devices, rec).sessionsObserved, 6, 'unset: every circuit');
  });
  await withEnv({ ...EV_UNSET, EV_CIRCUITS: '10' }, () => {
    resetEvWindowCache();
    assert.equal(computeEvWindowPrediction(devices, rec).sessionsObserved, 3, 'only the pair whose second leg is listed');
  });
  const liveRec = recorderFor({ pair5_w: live(10_500) });
  await withEnv({ ...EV_UNSET }, () => assert.equal(detectLiveEvSession(devices, liveRec, Date.now(), null)?.circuit, 5));
  await withEnv({ ...EV_UNSET, EV_CIRCUITS: '9' }, () => assert.equal(detectLiveEvSession(devices, liveRec, Date.now(), null), null, 'circuit 5 is not scanned'));
  await withEnv({ ...EV_UNSET, EV_CIRCUITS: '5,9' }, () => assert.equal(detectLiveEvSession(devices, liveRec, Date.now(), null)?.circuit, 5));
  resetEvWindowCache();
});

test('★ EV_CHARGER_COUNT 0: no circuit is classed as EV charging', async () => {
  const devices = panelWith([{ primaryCh: 5, secondaryCh: null }]);
  await withEnv({ ...EV_UNSET, EV_CHARGER_COUNT: '0' }, () => {
    resetEvWindowCache();
    const r = computeEvWindowPrediction(devices, recorderFor({ pair5_w: [...scattered(10_500), ...live(10_500)] }));
    assert.equal(r.sessionsObserved, 0);
    assert.equal(r.liveSession, undefined);
    assert.equal(r.upcomingNext24h.length, 0, 'no live session is overlaid on the forecast');
    assert.equal(detectLiveEvSession(devices, recorderFor({ pair5_w: live(10_500) }), Date.now(), null), null);
  });
  resetEvWindowCache();
});

test('★ EV_PLATEAU_MIN_W set reaches both detectors; unset a 5 kW load is not EV', async () => {
  const devices = panelWith([{ primaryCh: 5, secondaryCh: null }]);
  const rec = recorderFor({ pair5_w: scattered(5000) });
  const today = await freshAnalytics({});
  today.resetEvWindowCache();
  assert.equal(today.computeEvWindowPrediction(devices, rec).sessionsObserved, 0, 'below the 6000 W plateau');
  assert.equal(today.detectLiveEvSession(devices, recorderFor({ pair5_w: live(5000) }), Date.now(), null), null);
  const lower = await freshAnalytics({ EV_PLATEAU_MIN_W: '4000' });
  lower.resetEvWindowCache();
  assert.equal(lower.computeEvWindowPrediction(devices, rec).sessionsObserved, 3, 'a smaller charger is EV once the plateau is lowered');
  assert.equal(lower.detectLiveEvSession(devices, recorderFor({ pair5_w: live(5000) }), Date.now(), null)?.watts, 5000);
});

test('★ EV_MAX_LOAD_W set caps a live session\'s projected draw', async () => {
  const devices = panelWith([{ primaryCh: 5, secondaryCh: null }]);
  const today = await freshAnalytics({});
  assert.equal(today.detectLiveEvSession(devices, recorderFor({ pair5_w: live(12_000) }), Date.now(), null)?.watts, 11_520);
  const capped = await freshAnalytics({ EV_MAX_LOAD_W: '7200' });
  assert.equal(capped.detectLiveEvSession(devices, recorderFor({ pair5_w: live(12_000) }), Date.now(), null)?.watts, 7200);
});
