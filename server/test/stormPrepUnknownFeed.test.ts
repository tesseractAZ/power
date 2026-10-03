/**
 * v1.187.3 (log review) — a failed NWS fetch with nothing cached is UNKNOWN storm alerts, not none.
 *
 * getNwsAlerts returns its last good feed when a fetch fails, and null until one has succeeded.
 * stormPrepAlerts turned that null into [] and cached it for STORM_PREP_TTL_MS (10 min, the whole
 * broadcast warm-up), so after a restart whose first api.weather.gov call failed the storm-prep
 * feed read as a warm delivery (value [], error null) and alertSetTrusted counted the set as
 * settled: a green could be announced as a recovery ("All clear") over an NWS warning still in
 * effect. It now throws and caches nothing, so the feed stays cold until a fetch succeeds. A
 * successful fetch with no alerts is still [].
 *
 * (seam fix, LOW) Nothing bounded the retries: until NWS first answered, every 20 s alert-monitor
 * pass (and every /api/nws-alerts or calendar request) sent a request. getNwsAlerts now backs off a
 * failed fetch (NWS_ALERTS_FAILURE_BACKOFF_MS, 2 min), answering inside it as the failure did — the
 * last good feed, or null: still unknown, never "no storms" — and concurrent callers share one
 * request.
 *
 * api.weather.gov is mocked at the HTTP layer (undici MockAgent); the clock is controllable so the
 * module caches can be expired. The tests share the module caches and run in order.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from 'undici';

/* ── environment: set BEFORE any src module is loaded ── */
const ROOT = mkdtempSync(resolve(tmpdir(), 'ef-stormprep-'));
process.env.DB_PATH = resolve(ROOT, 'ecoflow.db');
process.env.NWS_ENABLED = 'true';

const realNow = Date.now.bind(Date);
let offset = 0;
Date.now = () => realNow() + offset;
const MIN = 60_000;

/* ── api.weather.gov, mocked ── */
let fetches = 0;
let reply: { status: number; body: string } = { status: 503, body: 'Service Unavailable' };
const agent = new MockAgent();
agent.disableNetConnect();
const prevDispatcher = getGlobalDispatcher();
setGlobalDispatcher(agent);
agent.get('https://api.weather.gov')
  .intercept({ path: (p: string) => p.startsWith('/alerts/active'), method: 'GET' })
  .reply(() => {
    fetches += 1;
    return { statusCode: reply.status, data: reply.body };
  })
  .persist();

const { stormPrepAlerts, getActiveNwsAlerts } = await import('../src/analytics.js');
const { createLastGoodFeed, alertSetTrusted } = await import('../src/alertMonitor.js');
const { NWS_ALERTS_FAILURE_BACKOFF_MS, nwsAlertsBackingOff } = await import('../src/nws.js');
const BACKOFF = NWS_ALERTS_FAILURE_BACKOFF_MS;

after(async () => {
  setGlobalDispatcher(prevDispatcher);
  await agent.close();
  rmSync(ROOT, { recursive: true, force: true });
});

const feature = (event: string, severity: string) => ({
  id: `urn:oid:2.49.0.1.840.0.${event.length}`,
  properties: {
    event, severity, certainty: 'Observed', urgency: 'Expected',
    onset: null, effective: null, ends: null, expires: null,
    headline: `${event} in effect`, description: null, instruction: null, areaDesc: 'Maricopa',
  },
});

test('★★★ the first fetch after a restart fails: the storm-prep feed stays COLD (unknown), and the alert set is not settled', async () => {
  // As the alert monitor reads it: a LastGoodFeed over the production stormPrepAlerts.
  const logs: string[] = [];
  const feed = createLastGoodFeed<unknown[]>('storm-prep', (m) => logs.push(m));
  const read = await feed.read(() => stormPrepAlerts({}), 2_000);
  assert.equal(fetches, 1, 'api.weather.gov was asked');
  assert.equal(read.value, null, 'no value: the storm alerts are unknown, not an empty list');
  assert.equal(read.warm, false, 'not a delivery');
  assert.equal(feed.warm(), false);
  assert.match(read.error ?? '', /failed — NWS alerts unknown/);
  assert.ok(logs.some((l) => l.includes('storm-prep has no value yet') && l.includes('UNKNOWN this pass, not cleared')));
  // The set the broadcast reads cannot count as settled with this feed in it.
  const settled = alertSetTrusted({ firstPollSettledAt: 1, feedsInSet: [true, read.warm, true, true, true], liveAtMs: 10 * MIN, pendingOnsets: [] });
  assert.equal(settled, false);
  assert.equal(alertSetTrusted({ firstPollSettledAt: 1, feedsInSet: [true, true, true, true, true], liveAtMs: 10 * MIN, pendingOnsets: [] }), true, 'control: the same set with the feed delivered');
});

test('★★★ a failed fetch is not cached as "no storms", and NWS is asked again only after the backoff (seam fix): still unknown inside it, at a bounded rate', async () => {
  const before = fetches;
  await assert.rejects(() => stormPrepAlerts({}), /NWS alerts unknown/);
  assert.equal(fetches, before, 'inside the backoff: no request — and still unknown, not "no storms"');
  assert.deepEqual(await getActiveNwsAlerts(), [], 'the alerts route answers as the failure did, without a request');
  assert.equal(fetches, before);
  offset += BACKOFF - 5_000;
  await assert.rejects(() => stormPrepAlerts({}), /NWS alerts unknown/);
  assert.equal(fetches, before, '5 s short of the backoff');
  offset += 6_000;
  await assert.rejects(() => stormPrepAlerts({}), /NWS alerts unknown/);
  assert.equal(fetches, before + 1, 'asked again after the backoff: the failure was not cached as "no storms"');
  await assert.rejects(() => stormPrepAlerts({}), /NWS alerts unknown/);
  assert.equal(fetches, before + 1, 'and backing off again after the new failure');
});

test('★★ concurrent callers share one request (the monitor, the alerts route), and all read the failure as unknown', async () => {
  offset += BACKOFF;
  const before = fetches;
  const [a, b, c] = await Promise.allSettled([stormPrepAlerts({}), stormPrepAlerts({}), getActiveNwsAlerts()]);
  assert.equal(fetches, before + 1, 'one request');
  assert.equal(a.status, 'rejected');
  assert.equal(b.status, 'rejected');
  assert.deepEqual(c.status === 'fulfilled' ? c.value : null, []);
});

test('nwsAlertsBackingOff — inside the backoff after a failure only; no failure, the backoff elapsed, or a failure "in the future" (the clock stepped back) asks', () => {
  const t = 1_000_000_000;
  assert.equal(nwsAlertsBackingOff(null, t), false, 'no failure yet');
  assert.equal(nwsAlertsBackingOff(t, t), true);
  assert.equal(nwsAlertsBackingOff(t, t + BACKOFF - 1), true);
  assert.equal(nwsAlertsBackingOff(t, t + BACKOFF), false, 'the backoff elapsed');
  assert.equal(nwsAlertsBackingOff(t, t - 1), false, 'the clock stepped back: asked, not held until it catches up');
  assert.equal(nwsAlertsBackingOff(t, t + 10, 10), false, 'the backoff is a parameter');
  assert.ok(BACKOFF >= 60_000 && BACKOFF <= 5 * 60_000, 'at least a minute between failed attempts, and a recovered NWS is read within minutes');
});

test('★★ a successful fetch with no alerts is still an empty list (a warm delivery), cached', async () => {
  offset += BACKOFF; // past the last failure's backoff
  reply = { status: 200, body: JSON.stringify({ features: [] }) };
  const feed = createLastGoodFeed<unknown[]>('storm-prep');
  const read = await feed.read(() => stormPrepAlerts({}), 2_000);
  assert.deepEqual(read.value, []);
  assert.equal(read.warm, true);
  assert.equal(read.error, null);
  const n = fetches;
  assert.deepEqual(await stormPrepAlerts({}), []);
  assert.equal(fetches, n, 'served from the cache');
});

test('★★ once a fetch has succeeded, a later failure serves the last good feed (getNwsAlerts keeps it): a warning stays a warning', async () => {
  offset += 20 * MIN; // past both caches
  reply = { status: 200, body: JSON.stringify({ features: [feature('Severe Thunderstorm Warning', 'Severe')] }) };
  const got = await stormPrepAlerts({});
  assert.deepEqual(got.map((a) => [a.id, a.severity]), [['storm-Severe_Thunderstorm_Warning', 'warning']]);
  offset += 20 * MIN;
  reply = { status: 503, body: 'Service Unavailable' };
  const n = fetches;
  const again = await stormPrepAlerts({});
  assert.equal(fetches, n + 1, 'it asked');
  assert.deepEqual(again.map((a) => a.id), ['storm-Severe_Thunderstorm_Warning'], 'the last good feed, not unknown and not empty');
  assert.deepEqual((await getActiveNwsAlerts()).map((a) => a.event), ['Severe Thunderstorm Warning'], 'inside the backoff the last good feed is served');
  assert.equal(fetches, n + 1, 'without a request');
});
