import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shp2Panels, shp2ConnectedDpuSns, findShp2 } from '../src/shp2Membership.js';
import { isNeverMutedAlert } from '../src/alerts.js';
import type { DeviceSnapshot } from '../src/snapshot.js';

/**
 * v1.129.0 — the SECOND-SHP2 guard, organised by INVARIANT rather than by module.
 *
 * MOTIVATING PLAN: a second Smart Home Panel will carry the EV charger and the
 * garage AC. The whole app resolves ONE panel via `find(kind === 'shp2')`, so on
 * the day panel #2 is energised its Cores are absent from panel #1's sources[],
 * read as off-panel hardware, and — three 20 s ticks later, and again after every
 * restart, because the streak map is in memory — every alert carrying their SNs
 * is stamped annunciate:false. No chime, no speech, no push, for every fault
 * class except overheating. That includes `dpu-err-<sn>`: the error-533 family
 * that has ALREADY failed on this plant.
 *
 * The guard does not make the numbers right. It makes the wrongness LOUD, and
 * takes away the app's licence to mute hardware it cannot place. Two properties
 * carry the design:
 *
 *   INERT AT ONE  — with one panel, nothing changes. The whole existing suite
 *                   passing UNMODIFIED is the real evidence; these tests pin the
 *                   specific expressions so a future edit cannot erode it.
 *   LOUD AT TWO   — a critical that nothing can mute, raised on STATE (so it
 *                   fires whenever the panel appears, not only if someone was
 *                   watching) and on product identity as well as projection (so
 *                   it is already standing during the pre-hydration window in
 *                   which the demotion streaks are accumulating).
 */

const CORE1 = 'Y711ZAB59GBC0314';
const CORE5 = 'Y711ZAB59G9P0090';
const PANEL_A = 'HW51ZAS4HF3X0001';
const PANEL_B = 'HW51ZAS4HF3X0002';

const dpu = (sn: string): DeviceSnapshot => ({
  sn, deviceName: sn, productName: 'DELTA Pro Ultra', online: true, lastUpdated: 1,
  projection: { kind: 'dpu' } as any,
} as DeviceSnapshot);

const panel = (sn: string, sources: string[] = []): DeviceSnapshot => ({
  sn, deviceName: sn, productName: 'Smart Home Panel 2', online: true, lastUpdated: 1,
  projection: { kind: 'shp2', sources: sources.map((s) => ({ sn: s, isConnected: true })) } as any,
} as DeviceSnapshot);

/** A panel in /device/list whose /quota has NOT hydrated — no projection at all. */
const unhydratedPanel = (sn: string): DeviceSnapshot => ({
  sn, deviceName: sn, productName: 'Smart Home Panel 2', online: true, lastUpdated: 1,
} as DeviceSnapshot);

const devices = (...a: DeviceSnapshot[]) => Object.fromEntries(a.map((d) => [d.sn, d]));


test('INERT AT ONE — the census does not trip on a single panel, or on none', () => {
  assert.equal(shp2Panels(devices()).sns.length, 0, 'no panels');
  assert.equal(shp2Panels(devices(dpu(CORE1))).sns.length, 0, 'DPUs are not panels');
  const one = shp2Panels(devices(panel(PANEL_A, [CORE1, CORE5]), dpu(CORE1), dpu(CORE5)));
  assert.equal(one.sns.length, 1, 'the realistic one-panel plant reads as ONE');
  assert.equal(one.primarySn, PANEL_A);
});

test('INERT AT ONE — the roster union over one panel IS that panel', () => {
  // The Phase-1 change swapped find() for a union. On a one-panel plant the two
  // are the same set by construction, which is what made it safe to ship ahead
  // of the hardware.
  const d = devices(panel(PANEL_A, [CORE1, CORE5]), dpu(CORE1), dpu(CORE5));
  assert.deepEqual([...shp2ConnectedDpuSns(d)].sort(), [CORE1, CORE5].sort());
});

test('LOUD AT TWO — a second panel trips the census even BEFORE its quota hydrates', () => {
  // This is the window that matters: panel #2 is in /device/list, has no
  // projection yet, and its Cores are ALREADY accumulating off-panel streaks.
  // A census keyed only on projection.kind would stay silent through exactly the
  // interval it exists to cover.
  const c = shp2Panels(devices(panel(PANEL_A, [CORE1]), unhydratedPanel(PANEL_B), dpu(CORE1), dpu(CORE5)));
  assert.equal(c.sns.length, 2, 'an unhydrated panel still counts');
  assert.equal(c.projectedCount, 1, 'only one has a projection');
  assert.equal(c.identityCount, 2, 'both are identifiable by product name');
});

test('LOUD AT TWO — the roster is the UNION, so a Core on panel B is not off-panel', () => {
  // The upstream cause of the worst finding. Before the union, CORE5 was absent
  // from panel A's sources[] and therefore looked like bench hardware.
  const d = devices(panel(PANEL_A, [CORE1]), panel(PANEL_B, [CORE5]), dpu(CORE1), dpu(CORE5));
  const roster = shp2ConnectedDpuSns(d);
  assert.ok(roster.has(CORE1), 'panel A core');
  assert.ok(roster.has(CORE5), 'panel B core — the one that used to be demoted');
  assert.equal(roster.size, 2);
});

test('DETERMINISM — the primary panel is pinned by SN, not by map order', () => {
  // Which panel the singleton paths describe must not change between restarts.
  const forward = devices(panel(PANEL_A, [CORE1]), panel(PANEL_B, [CORE5]));
  const reverse = devices(panel(PANEL_B, [CORE5]), panel(PANEL_A, [CORE1]));
  assert.equal(shp2Panels(forward).primarySn, PANEL_A);
  assert.equal(shp2Panels(reverse).primarySn, PANEL_A, 'same answer under reversed iteration order');
  assert.equal(findShp2(forward)?.sn, PANEL_A);
  assert.equal(findShp2(reverse)?.sn, PANEL_A, 'findShp2 agrees with the census');
  assert.equal(findShp2(devices(panel(PANEL_B, [CORE5])))?.sn, PANEL_B, 'one panel: that panel');
});

test('LOUD AT TWO — the guard alert is exempt from every muting path', () => {
  // If anything could mute it, that thing is one of the mechanisms it warns about.
  assert.ok(isNeverMutedAlert({ id: 'shp2-multi-panel', severity: 'critical', category: 'SHP2' } as any));
  // And it carries no SN in its id, so the id.includes(sn) demotion cannot match it.
  for (const sn of [CORE1, CORE5, PANEL_A, PANEL_B]) {
    assert.ok(!'shp2-multi-panel'.includes(sn), `id must not embed ${sn}`);
  }
});

test('the census counts DISTINCT panels, not device-map entries', () => {
  const dupe = { ...devices(panel(PANEL_A, [CORE1])), alias: panel(PANEL_A, [CORE1]) };
  assert.equal(shp2Panels(dupe as any).sns.length, 1, 'one physical panel listed twice is still one');
});
