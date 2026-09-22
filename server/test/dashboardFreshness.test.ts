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
  linkState, oldestHomeTelemetryAt, homeDevices, pollStale, dayWindowExpired, readingAt, isPanel, staleAsOf, nextClockOffset,
  TELEMETRY_STALE_MS, POLL_STALE_MISSES,
} from '../../web/src/freshness.js';

type Any = any;
const NOW = Date.UTC(2026, 8, 22, 10, 25); // 03:25 local, mid-outage
const S = 1000, MIN = 60_000;

// Fixtures stamp BOTH clocks with the reading time; tests that need them to differ set
// lastTelemetryAtMs explicitly. (readingAt reads only lastTelemetryAtMs.)
const dpu = (sn: string, at: number, online = true): Any => ({
  sn, deviceName: sn, online, lastUpdated: at, ...(at > 0 ? { lastTelemetryAtMs: at } : {}), projection: { kind: 'dpu' },
});
const shp2 = (at: number, sources: string[]): Any => ({
  sn: 'SHP2', deviceName: 'SHP2', online: true, lastUpdated: at, ...(at > 0 ? { lastTelemetryAtMs: at } : {}),
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
  const win = { sinceMs: midnight, dayEndMs: midnight + 24 * 3_600_000 };
  assert.equal(dayWindowExpired(win, midnight + 23 * 3_600_000), false, 'late tonight: still today');
  assert.equal(dayWindowExpired(win, midnight + 24 * 3_600_000), true, 'past the next midnight: yesterday');
  assert.equal(dayWindowExpired(null, NOW), false);
});

test('★★ a daylight-saving fall-back day (25 h) keeps its last hour — the server’s dayEndMs, not 24 h', () => {
  const midnight = Date.UTC(2026, 10, 1, 4, 0); // 2026-11-01 00:00 EDT
  const win = { sinceMs: midnight, dayEndMs: midnight + 25 * 3_600_000 };
  assert.equal(dayWindowExpired(win, midnight + 24.5 * 3_600_000), false, '23:30 on the long day is still today');
  assert.equal(dayWindowExpired(win, midnight + 25 * 3_600_000), true);
  assert.equal(dayWindowExpired({ sinceMs: midnight }, midnight + 24 * 3_600_000), true, 'an older server (no dayEndMs) falls back to 24 h');
});

/* ══ wiring ════════════════════════════════════════════════════════════════ */

const here = dirname(fileURLToPath(import.meta.url));
const web = (f: string) => readFileSync(resolve(here, '../../web/src/', f), 'utf8');

test('the header and pill read the freshness model and a ticking clock, not generatedAt or readyState', () => {
  const app = web('App.tsx');
  assert.ok(app.includes('updated {fmtRel(oldestReading, serverNow)}'), 'header age = oldest home reading, on the server clock');
  assert.ok(app.includes('const serverNow = now - clockOffsetMs;'), 'ages are measured on the server’s clock');
  assert.ok(app.includes("{' · '}"), 'the separator keeps its spaces (a JSX line break had eaten one)');
  assert.ok(!app.includes('fmtRel(snapshot?.generatedAt'), 'generatedAt (bumped by poll failures) no longer drives the header');
  assert.ok(app.includes('const link = linkState(conn, snapshot?.devices ?? null, serverNow);'));
  assert.ok(app.includes('const now = useNow('), 'a ticking clock keeps ages moving when nothing arrives');
  assert.ok(app.includes('{link}') && !app.includes("{conn === 'open' ? 'live'"), 'the pill prints the link state');
});

test('Runway and Today poll through usePolled and mark a stale payload; Insights rejects non-OK', () => {
  const runway = web('cards/RunwayCard.tsx');
  assert.ok(runway.includes("usePolled<RunwayProjection>('api/runway', RUNWAY_POLL_MS)"));
  assert.ok(runway.includes('pollStale(lastOkAt, now, RUNWAY_POLL_MS)') && runway.includes('<StaleNote'));
  const today = web('cards/TodaySummary.tsx');
  assert.ok(today.includes("usePolled<SummaryResp>('api/summary/today', TODAY_POLL_MS)"));
  assert.ok(today.includes('!dayWindowExpired(polled.data, serverNow)'), 'yesterday is dropped, not relabelled');
  assert.ok(today.includes('pollStale(polled.lastOkAt, now, TODAY_POLL_MS)') && today.includes('<StaleNote'));
  const hook = web('usePolled.ts');
  assert.ok(hook.includes('if (!r.ok) {'), 'a non-OK response is a failure in the shared hook');
  const insights = web('cards/AdvancedInsightsCard.tsx');
  assert.ok(insights.includes('r.ok ? r.json() : Promise.reject('), 'an HTTP 500 body is never set as data');
});

/* ══ v1.176.0 review: the clock must be moved only by real telemetry ══════ */

test('★★★ a panel replaying a cloud shadow is STALE even though every poll answers 200 OK', () => {
  // The REST poll keeps landing (telemetry clock 20 s old); the content has been frozen 6 min.
  const p = shp2(NOW - 20 * S, HOME);
  p.lastTelemetryAtMs = NOW - 20 * S;
  p.contentStaleSinceMs = NOW - 6 * MIN;
  const d = devs(p, dpu('C1', NOW), dpu('C2', NOW), dpu('C5', NOW));
  assert.equal(readingAt(p), NOW - 6 * MIN, 'the panel’s figures are as old as the shadow');
  assert.equal(linkState('open', d, NOW), 'stale');
});

test('★★ a /status flip does not refresh the reading — lastTelemetryAtMs does, lastUpdated does not', () => {
  // The flip stamped lastUpdated just now; the last real telemetry was 4 min ago.
  const p = shp2(NOW, HOME);
  p.lastTelemetryAtMs = NOW - 4 * MIN;
  const d = devs(p, dpu('C1', NOW), dpu('C2', NOW), dpu('C5', NOW));
  assert.equal(linkState('open', d, NOW), 'stale');
});

test('★★★ after a restart while the panel is dark, the panel (no projection yet) still counts — by identity', () => {
  // Listed by /device/list, no projection, never reported. The Cores stream. The old
  // projection-keyed test dropped the panel and read LIVE on the Cores alone.
  const dark: Any = { sn: 'SHP2', deviceName: 'Smart Home Panel 2', productName: 'Smart Home Panel 2', online: false, lastUpdated: 0 };
  const d = devs(dark, dpu('C1', NOW), dpu('C2', NOW), dpu('C5', NOW), dpu('BENCH', NOW));
  assert.equal(isPanel(dark), true);
  assert.ok(homeDevices(d).some((x: Any) => x.sn === 'SHP2'));
  assert.equal(linkState('open', d, NOW), 'stale', 'a panel with no reading is not LIVE data');
});

test('★★ an OFFLINE home Core is out of the headline figures and out of the pill (its own alarm covers it)', () => {
  const c2: Any = dpu('C2', NOW - 9 * 24 * 3_600_000, false);
  c2.lastTelemetryAtMs = NOW - 9 * 24 * 3_600_000;
  const d = devs(shp2(NOW - 30 * S, HOME), dpu('C1', NOW), c2, dpu('C5', NOW));
  assert.deepEqual(homeDevices(d).map((x: Any) => x.sn).sort(), ['C1', 'C5', 'SHP2']);
  assert.equal(linkState('open', d, NOW), 'live', 'a Core dark for nine days does not pin the pill amber');
});

test('ages are measured against the SERVER’s now: a skewed viewer clock does not flip the pill', () => {
  // Healthy data, viewer clock 5 min fast. App passes serverNow = browserNow − offset.
  const offset = 5 * MIN;
  const browserNow = NOW + offset;
  assert.equal(linkState('open', healthy(NOW), browserNow - offset), 'live');
  assert.equal(linkState('open', healthy(NOW), browserNow), 'stale', '(what the uncorrected browser clock would have said)');
});

test('★ a stale payload from an earlier day names its day', () => {
  const at = new Date(2026, 8, 21, 15, 0).getTime();
  const sameDay = staleAsOf(at, new Date(2026, 8, 21, 16, 0).getTime())!;
  const nextDay = staleAsOf(at, new Date(2026, 8, 22, 16, 0).getTime())!;
  assert.ok(!/Mon|Tue|Wed|Thu|Fri|Sat|Sun/.test(sameDay), `same day shows the time only: ${sameDay}`);
  assert.match(nextDay, /Mon|Tue|Wed|Thu|Fri|Sat|Sun/, `an earlier day names the day: ${nextDay}`);
  assert.equal(staleAsOf(null, NOW), null);
});

test('the server stamps its clock on every frame at SEND time, and the day end on Today', () => {
  const idx = readFileSync(resolve(here, '../src/index.ts'), 'utf8');
  assert.ok(idx.includes('return `{"type":"snapshot","serverNowMs":${Date.now()},"data":${wsDataStr}}`;'),
    'the stamp is per send, not cached with the body');
  assert.ok(idx.includes('dayEndMs: end.getTime()'), '/api/summary/today carries the day end');
  const hook = web('useSnapshot.ts');
  assert.ok(hook.includes('nextClockOffset(minOffset, Date.now() - m.serverNowMs)') && hook.includes('minOffset = null;'), 'min offset per socket, reset on reconnect');
});

test('other pages no longer store an HTTP error body as data (each crashed the whole dashboard)', () => {
  const solar = web('pages/SolarPanel.tsx');
  assert.ok(solar.includes('if (sumR.ok) {') && solar.includes('if (!r.ok) throw new Error(`history'), 'Solar tab: a failed series keeps the last good chart');
  assert.ok(solar.includes('dayWindowExpired(summaryState,'), 'Solar tab: an expired day is not "Today"');
  const modal = web('components/CircuitModal.tsx');
  assert.ok(modal.includes('const j2 = r2.ok ?') && modal.includes('if (j2 && Array.isArray(j2.days)) setHistory(j2);'), 'circuit modal');
  const curt = web('cards/CurtailmentCard.tsx');
  assert.ok(curt.includes("usePolled<CurtailmentReport>('api/curtailment', CURTAILMENT_POLL_MS)") && curt.includes('<StaleNote'), 'curtailment marks stale');
});

/* ══ v1.176.0 re-review ════════════════════════════════════════════════════ */

test('★★★ after a restart, a panel whose /status flips but has sent no telemetry is STALE, not LIVE', () => {
  // setDeviceOnline stamped lastUpdated 30 s ago; no quota has landed since boot. A
  // `lastTelemetryAtMs ?? lastUpdated` fallback read that flip as a fresh reading.
  const panel: Any = { sn: 'SHP2', deviceName: 'Smart Home Panel 2', productName: 'Smart Home Panel 2', online: true, lastUpdated: NOW - 30 * S };
  const d = devs(panel, dpu('C1', NOW), dpu('C2', NOW), dpu('C5', NOW));
  assert.equal(readingAt(panel), 0, 'no telemetry since boot');
  assert.equal(linkState('open', d, NOW), 'stale');
});

test('★★ the clock offset is the MINIMUM sample: a growing transport backlog shows as age, not skew', () => {
  // Skew 2 s; frames arrive with a lag growing from 0.1 s to 180 s.
  let off: number | null = null;
  for (const lag of [100, 400, 5_000, 60_000, 180_000]) off = nextClockOffset(off, 2_000 + lag);
  assert.equal(off, 2_100, 'the least-delayed frame sets the offset; the backlog is not absorbed');
  // A later, less-delayed frame lowers it (a better estimate).
  assert.equal(nextClockOffset(off, 2_010), 2_010);
  // A fresh socket starts over (reconnect).
  assert.equal(nextClockOffset(null, -45_000), -45_000, 'a slow viewer clock is a negative offset');
});
