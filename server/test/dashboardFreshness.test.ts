/**
 * v1.176.0 — the dashboard's freshness signals, run against the pure web module
 * (web/src/freshness.ts), the same way webServerMembershipParity runs the web membership
 * code.
 *
 * Before: the header printed `snapshot.generatedAt`, which a poll FAILURE refreshes
 * (snapshot.ts setDeviceError), and the LIVE pill was the WebSocket's readyState alone —
 * open for the whole 2026-09-22 03:17-03:28 cloud outage. Both read "fresh" over data
 * eleven minutes old.
 *
 * Live cadence measured 2026-09-22: the three home Cores report every ~1 s (MQTT), the
 * panel every ~60 s (REST poll) — so the oldest home reading is normally ≤ 60 s, well
 * inside the 3-minute "Telemetry stale" threshold the alarm engine uses.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  linkState, oldestHomeTelemetryAt, homeDevices, pollStale, dayWindowExpired,
  TELEMETRY_STALE_MS, POLL_STALE_MISSES,
} from '../../web/src/freshness.js';

type Any = any;
const NOW = Date.UTC(2026, 8, 22, 10, 25); // 03:25 local, mid-outage
const S = 1000, MIN = 60_000;

const dpu = (sn: string, lastUpdated: number, online = true): Any => ({ sn, deviceName: sn, online, lastUpdated, projection: { kind: 'dpu' } });
const shp2 = (lastUpdated: number, sources: string[]): Any => ({
  sn: 'SHP2', deviceName: 'SHP2', online: true, lastUpdated,
  projection: { kind: 'shp2', sources: sources.map((sn, i) => ({ slot: i + 1, sn, isConnected: true })) },
});
const other = (sn: string, lastUpdated: number): Any => ({ sn, deviceName: sn, online: false, lastUpdated, projection: { kind: 'other' } });
const devs = (...ds: Any[]) => Object.fromEntries(ds.map((d) => [d.sn, d]));
const HOME = ['C1', 'C2', 'C5'];

/** The healthy live cadence: Cores ~1 s, panel up to ~60 s. */
const healthy = (at: number) => devs(
  shp2(at - 58 * S, HOME), dpu('C1', at - 1 * S), dpu('C2', at - 1 * S), dpu('C5', at),
  dpu('BENCH', at - 6 * 3_600_000), other('DOORBELL', 0),
);

/* ══ the LIVE pill ═════════════════════════════════════════════════════════ */

test('the healthy live cadence reads LIVE — a 60 s panel poll is not stale', () => {
  assert.equal(linkState('open', healthy(NOW), NOW), 'live');
});

test('★★★ an open socket over readings older than the stale threshold reads STALE (the 03:17-03:28 outage)', () => {
  // Eight minutes into the outage every home reading is eight minutes old, the socket
  // still open. The old pill said LIVE here.
  const d = devs(shp2(NOW - 8 * MIN, HOME), dpu('C1', NOW - 8 * MIN), dpu('C2', NOW - 8 * MIN), dpu('C5', NOW - 8 * MIN));
  assert.equal(linkState('open', d, NOW), 'stale');
});

test('★★ ONE stale home device is enough — the pill reads the OLDEST reading, not the newest', () => {
  // Cores streaming, panel gone quiet for 5 minutes: the Loads figure on screen is 5 min old.
  const d = devs(shp2(NOW - 5 * MIN, HOME), dpu('C1', NOW), dpu('C2', NOW), dpu('C5', NOW));
  assert.equal(linkState('open', d, NOW), 'stale');
  assert.equal(oldestHomeTelemetryAt(d), NOW - 5 * MIN);
});

test('a bench Core and accessory devices never paint the dashboard stale', () => {
  const d = healthy(NOW);
  assert.deepEqual(homeDevices(d).map((x: Any) => x.sn).sort(), ['C1', 'C2', 'C5', 'SHP2']);
  assert.equal(linkState('open', d, NOW), 'live', 'a six-hour-old bench reading and a never-reporting doorbell are excluded');
});

test('a home device that has never reported reads STALE — blanks on screen are not fresh data', () => {
  const d = devs(shp2(NOW, HOME), dpu('C1', NOW), dpu('C2', NOW), dpu('C5', 0));
  assert.equal(oldestHomeTelemetryAt(d), null);
  assert.equal(linkState('open', d, NOW), 'stale');
});

test('the threshold matches the alarm engine’s "Telemetry stale" (3 min), boundary inclusive of fresh', () => {
  assert.equal(TELEMETRY_STALE_MS, 3 * MIN);
  const at = (age: number) => devs(shp2(NOW - age, HOME), dpu('C1', NOW), dpu('C2', NOW), dpu('C5', NOW));
  assert.equal(linkState('open', at(TELEMETRY_STALE_MS), NOW), 'live');
  assert.equal(linkState('open', at(TELEMETRY_STALE_MS + 1), NOW), 'stale');
});

test('link states outrank freshness: a closed socket is OFFLINE, a connecting one LINKING', () => {
  assert.equal(linkState('closed', healthy(NOW), NOW), 'offline');
  assert.equal(linkState('connecting', healthy(NOW), NOW), 'linking');
  assert.equal(linkState('open', null, NOW), 'linking', 'open but no snapshot yet');
});

test('a cold boot with no panel observed falls back to the online Cores, like the Energy flow card', () => {
  const d = devs(dpu('C1', NOW), dpu('OFFLINE', NOW - 9 * MIN, false));
  assert.deepEqual(homeDevices(d).map((x: Any) => x.sn), ['C1']);
  assert.equal(linkState('open', d, NOW), 'live');
});

/* ══ polled cards ══════════════════════════════════════════════════════════ */

test('★★ a polled card is stale once it has missed 2.5 of its polls, and never-fetched is stale', () => {
  assert.equal(POLL_STALE_MISSES, 2.5);
  assert.equal(pollStale(NOW - 60 * S, NOW, MIN), false, 'one poll ago is current');
  assert.equal(pollStale(NOW - 150 * S, NOW, MIN), false, 'exactly 2.5 polls is still current');
  assert.equal(pollStale(NOW - 151 * S, NOW, MIN), true);
  assert.equal(pollStale(null, NOW, MIN), true);
});

test('★★★ yesterday’s Today totals are dropped once their day is over', () => {
  const midnight = Date.UTC(2026, 8, 22, 7, 0); // 00:00 local (UTC-7)
  assert.equal(dayWindowExpired(midnight, midnight + 23 * 3_600_000), false, 'late tonight: still today');
  assert.equal(dayWindowExpired(midnight, midnight + 24 * 3_600_000), true, 'past the next midnight: yesterday');
  assert.equal(dayWindowExpired(undefined, NOW), false);
});

/* ══ wiring ════════════════════════════════════════════════════════════════ */

const here = dirname(fileURLToPath(import.meta.url));
const web = (f: string) => readFileSync(resolve(here, '../../web/src/', f), 'utf8');

test('the header and pill read the freshness model and a ticking clock, not generatedAt or readyState', () => {
  const app = web('App.tsx');
  assert.ok(app.includes('updated {fmtRel(oldestReading, now)}'), 'header age = oldest home reading');
  assert.ok(!app.includes('fmtRel(snapshot?.generatedAt'), 'generatedAt (bumped by poll failures) no longer drives the header');
  assert.ok(app.includes('const link = linkState(conn, snapshot?.devices ?? null, now);'));
  assert.ok(app.includes('const now = useNow('), 'a ticking clock keeps ages moving when nothing arrives');
  assert.ok(app.includes('{link}') && !app.includes("{conn === 'open' ? 'live'"), 'the pill prints the link state');
});

test('Runway and Today poll through usePolled and mark a stale payload; Insights rejects non-OK', () => {
  const runway = web('cards/RunwayCard.tsx');
  assert.ok(runway.includes("usePolled<RunwayProjection>('api/runway', RUNWAY_POLL_MS)"));
  assert.ok(runway.includes('pollStale(lastOkAt, now, RUNWAY_POLL_MS)') && runway.includes('<StaleNote'));
  const today = web('cards/TodaySummary.tsx');
  assert.ok(today.includes("usePolled<SummaryResp>('api/summary/today', TODAY_POLL_MS)"));
  assert.ok(today.includes('!dayWindowExpired(polled.data.sinceMs, now)'), 'yesterday is dropped, not relabelled');
  assert.ok(today.includes('pollStale(polled.lastOkAt, now, TODAY_POLL_MS)') && today.includes('<StaleNote'));
  const hook = web('usePolled.ts');
  assert.ok(hook.includes('if (!r.ok) {'), 'a non-OK response is a failure in the shared hook');
  const insights = web('cards/AdvancedInsightsCard.tsx');
  assert.ok(insights.includes('r.ok ? r.json() : Promise.reject('), 'an HTTP 500 body is never set as data');
});
