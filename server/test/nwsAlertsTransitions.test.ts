/**
 * v1.187.10 (log review 10-03) — the NWS storm-alert client logs its state TRANSITIONS, through the
 * sinks the alert monitor installs.
 *
 * Both production callers (stormPrepAlerts on the alarm path, getActiveNwsAlerts for the display)
 * called getNwsAlerts() with no logger, so neither the success line nor the v1.187.3 failure line
 * could reach the journal: 40.8 h of log held no trace of a storm-alert fetch while the NWS cloud-
 * cover client logged 20. The client now logs through module sinks (setNwsLog), which
 * startAlertMonitor installs with its own info and warn sinks, and it logs transitions rather than
 * every success: the first answer, a change in the set of active events, the first failure of an
 * outage, and the recovery (the carry limit's WARNING is pinned in stormPrepUnknownFeed.test.ts).
 *
 * api.weather.gov is mocked at the HTTP layer (undici MockAgent); the clock is controllable so the
 * module caches can be expired. The tests share the module state and run in order.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from 'undici';
import { makeRecorderStub } from './helpers/recorderStub.js';

/* ── environment: set BEFORE any src module is loaded ── */
const ROOT = mkdtempSync(join(tmpdir(), 'ef-nws-transitions-'));
process.env.DB_PATH = join(ROOT, 'ecoflow.db');
process.env.NWS_ENABLED = 'true';
process.env.ALERT_EVAL_MS = '60000';
process.env.NOTIFY_STATE_PATH = join(ROOT, 'notify-state.json');
process.env.DIGEST_STATE_PATH = join(ROOT, 'digest.json');
process.env.CLEARED_LOG_PATH = join(ROOT, 'cleared.json');
process.env.NOTIFY_QUIET_HOURS = '';
delete process.env.NOTIFY_CHANNEL;
delete process.env.SUPERVISOR_TOKEN;

const realNow = Date.now.bind(Date);
let offset = 0;
Date.now = () => realNow() + offset;
const MIN = 60_000;

let fetches = 0;
let reply: { status: number; body: string } = { status: 200, body: '' };
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

const { getNwsAlerts, setNwsLog, TTL_MS } = await import('../src/nws.js');
const { startAlertMonitor } = await import('../src/alertMonitor.js');
const { SnapshotStore } = await import('../src/snapshot.js');

after(async () => {
  setGlobalDispatcher(prevDispatcher);
  await agent.close();
  rmSync(ROOT, { recursive: true, force: true });
});

const feature = (event: string) => ({
  id: `urn:oid:2.49.0.1.840.0.${event.length}`,
  properties: {
    event, severity: 'Severe', certainty: 'Observed', urgency: 'Expected',
    onset: null, effective: null, ends: null, expires: null,
    headline: `${event} in effect`, description: null, instruction: null, areaDesc: 'Maricopa',
  },
});
const answer = (...events: string[]) => ({ status: 200, body: JSON.stringify({ features: events.map(feature) }) });
const pastTtl = () => { offset += TTL_MS + MIN; };

const info: string[] = [];
const warns: string[] = [];

test('★★★ transitions only: the first answer, a changed event set, the first failure of an outage and the recovery — an unchanged answer and a repeat failure log nothing', async () => {
  setNwsLog((m) => info.push(m), (m) => warns.push(m));
  reply = answer('Severe Thunderstorm Warning');
  assert.equal((await getNwsAlerts())?.alerts.length, 1);
  assert.equal(info.length, 1);
  assert.match(info[0], /^nws: storm-alert feed live — 1 active alert\(s\) for [-\d.]+,[-\d.]+: Severe Thunderstorm Warning$/);

  pastTtl();
  assert.equal((await getNwsAlerts())?.alerts.length, 1);
  assert.equal(fetches, 2, 'asked again after the TTL');
  assert.equal(info.length, 1, 'the same events: no line');

  pastTtl();
  reply = answer('Flash Flood Warning', 'Severe Thunderstorm Warning');
  await getNwsAlerts();
  assert.equal(info.length, 2);
  assert.equal(info[1], 'nws: active alerts changed — 2 now: Flash Flood Warning, Severe Thunderstorm Warning');

  pastTtl();
  reply = { status: 503, body: 'Service Unavailable' };
  const carried = await getNwsAlerts();
  assert.equal(carried?.alerts.length, 2, 'inside the carry limit the last good feed is served');
  assert.equal(info.length, 3);
  assert.match(info[2], /^nws: storm-alert fetch failed \(HTTP 503\) — the last good feed \(16 min old\) is carried for at most 60 min; asked again every 120 s; logged once per outage, with a recovery line$/);

  offset += 3 * MIN;
  const n = fetches;
  await getNwsAlerts();
  assert.equal(fetches, n + 1, 'asked again after the backoff');
  assert.equal(info.length, 3, 'a repeat failure in the same outage: no line');

  offset += 3 * MIN;
  reply = answer();
  assert.deepEqual((await getNwsAlerts())?.alerts, []);
  assert.equal(info.length, 4);
  assert.equal(info[3], 'nws: storm-alert feed recovered after 2 failed attempt(s) over 6 min — 0 active alert(s)');
  assert.deepEqual(warns, [], 'nothing here reaches the warn sink');
});

test('★★★ the production wiring: startAlertMonitor installs its own info and warn sinks for the NWS client', async () => {
  setNwsLog(() => {});
  const logs: string[] = [];
  const mwarns: string[] = [];
  const store = new SnapshotStore();
  const mon = startAlertMonitor(store, makeRecorderStub({ telemetryGaps: () => [] }), (m) => logs.push(m), (m) => mwarns.push(m), {
    analytics: { report: async () => [] } as any,
    stormPrep: async () => [],
    captureLrFeatures: (async () => null) as any,
    send: (async () => {}) as any,
  });
  try {
    pastTtl();
    reply = answer('Excessive Heat Warning');
    await getNwsAlerts();
    assert.ok(logs.includes('nws: active alerts changed — 1 now: Excessive Heat Warning'), `the monitor's info sink got the line:\n${logs.join('\n')}`);
    // An outage past the carry limit reaches the monitor's WARN sink.
    pastTtl();
    reply = { status: 503, body: 'Service Unavailable' };
    await getNwsAlerts();
    offset += 61 * MIN;
    assert.equal(await getNwsAlerts(), null, 'past the carry limit: unknown on the alarm path');
    assert.equal(mwarns.filter((l) => l.startsWith('nws: WARNING — no successful storm-alert fetch')).length, 1, mwarns.join('\n'));
  } finally {
    mon.stop();
  }
});
