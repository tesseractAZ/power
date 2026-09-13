import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assessBlind, telemetryBlindAlerts, blindAlertContext, notePollFailed, notePollOk, pollState,
  TELEMETRY_BLIND_ALERT_ID, type BlindConfig, type PollFailure,
} from '../src/telemetryBlind.js';
import { SPARE_DPU_SNS, setLastKnownHomeRoster, resetLastKnownHomeRoster, isOutsideHomePool } from '../src/shp2Membership.js';

/**
 * v1.154.0 — the telemetry-blind CRITICAL, rendered for what actually happened.
 *
 * Since v1.148.0 a replayed SHP2 payload routes into this alert, as a failed or
 * never-asked panel fetch already did. All three rendered the text written for the
 * 2026-08-04 outage — the add-on "has received no telemetry" and "cannot see battery
 * state, grid presence or any device fault" — while the Cores were still streaming.
 * The title is spoken aloud, and the Cause fact read "unknown" although the verdict
 * naming the cause had just been computed.
 */

const CFG: BlindConfig = { bootGraceMs: 3 * 60_000, staleMs: 5 * 60_000, authFailuresBeforeHeal: 5, healCooldownMs: 10 * 60_000 };
const NOW = Date.UTC(2026, 8, 12, 11, 20, 0);
const MIN = 60_000;
const FROZEN: PollFailure = { cause: 'shp2-content-frozen', sns: ['SHP2-1'] };

type Dev = { deviceName?: string; online?: boolean; lastUpdated?: number; lastQuotaAtMs?: number | null; projection?: { kind?: string } | null };
const fleet = (): Record<string, Dev> => ({
  'SHP2-1': { deviceName: 'Smart Home Panel 2', online: true, lastUpdated: NOW, lastQuotaAtMs: NOW, projection: { kind: 'shp2' } },
  'DPU-1': { deviceName: 'Core 1', online: true, lastUpdated: NOW - 5_000, lastQuotaAtMs: NOW - 5_000, projection: { kind: 'dpu' } },
  'DPU-2': { deviceName: 'Core 2', online: true, lastUpdated: NOW - 20_000, lastQuotaAtMs: NOW - 20_000, projection: { kind: 'dpu' } },
});

const blindVerdict = (failure: PollFailure | null, lastError = 'SHP2 payload is a REPLAYED SHADOW — the fetch succeeded but the content is not moving (SHP2-1)') =>
  assessBlind({
    nowMs: NOW, bootMs: NOW - 60 * MIN, projectedDeviceCount: 3,
    lastPollOkMs: NOW - 7 * MIN, consecutiveFailures: 7, lastError,
    lastHealAtMs: null, lastFailure: failure,
  }, CFG);

const causeOf = (a: { facts?: Array<{ label: string; value: string }> }) => a.facts!.find((f) => f.label === 'Cause')!.value;

test('★ a replayed panel with the Cores still reporting is NOT announced as "the alarm system is blind"', () => {
  const v = blindVerdict(FROZEN);
  assert.equal(v.blind, true, 'precondition: the verdict is blind');
  const [a] = telemetryBlindAlerts(v, NOW, blindAlertContext(fleet(), v.failure, NOW, { staleMs: CFG.staleMs }));
  // Escalation is unchanged: same id, same severity, same priority.
  assert.equal(a.id, TELEMETRY_BLIND_ALERT_ID);
  assert.equal(a.severity, 'critical');
  assert.equal(a.priority, 'critical');
  // The rendered text, pinned whole — the title is what the speakers say.
  assert.equal(a.title, 'Panel data is stale — grid presence unknown');
  assert.equal(
    a.detail,
    'The alarm path has had no current data from Smart Home Panel 2 for 7 minutes: the fetch succeeds, but the '
    + "EcoFlow cloud is replaying a stale copy of the panel's data. Grid presence from the panel is being treated as "
    + 'UNKNOWN. Its other readings, including the backup reserve level, are not current either. 2 other devices are '
    + 'still reporting, but no alarm that depends on the panel can be trusted while this is true.',
  );
  assert.deepEqual(a.facts, [
    { label: 'No current panel data for', value: '7 min' },
    { label: 'Cause', value: 'cloud replaying a stale copy of the panel' },
    { label: 'Other devices reporting', value: '2' },
    { label: 'Since', value: new Date(NOW - 7 * MIN).toISOString() },
  ]);
  assert.doesNotMatch(a.detail, /no telemetry|cannot see battery state/, 'the false claim is gone');
});

test('with NOTHING else current, the original text stands — it is then true', () => {
  const v = blindVerdict(FROZEN);
  const devices = fleet();
  devices['DPU-1'].lastQuotaAtMs = NOW - 6 * MIN;   // lastUpdated is fresh, but only from a status flip
  devices['DPU-2'].online = false;
  const [a] = telemetryBlindAlerts(v, NOW, blindAlertContext(devices, v.failure, NOW, { staleMs: CFG.staleMs }));
  assert.equal(a.title, 'Alarm system is blind — no telemetry');
  assert.match(a.detail, /has received no telemetry for 7 minutes/);
  assert.equal(a.severity, 'critical');
  assert.equal(causeOf(a), 'cloud replaying a stale copy of the panel',
    'the Cause fact still names the verdict rather than "unknown"');
  assert.equal(a.facts!.some((f) => f.label === 'Other devices reporting'), false);
});

test('a caller that passes no context gets the original text', () => {
  const v = blindVerdict(FROZEN);
  const [a] = telemetryBlindAlerts(v, NOW);
  assert.equal(a.title, 'Alarm system is blind — no telemetry');
});

test('★ a failure that is NOT a panel verdict keeps the original wording and Cause mapping', () => {
  // A thrown poll carries no panel verdict. Other devices may still look current for a
  // few minutes from their last quota — that must not dress an auth outage up as a panel fault.
  const v = blindVerdict(null, 'EcoFlow API error 8521: signature is wrong');
  const [a] = telemetryBlindAlerts(v, NOW, blindAlertContext(fleet(), v.failure, NOW, { staleMs: CFG.staleMs }));
  assert.equal(a.title, 'Alarm system is blind — no telemetry');
  assert.match(a.detail, /clock/i);
  assert.equal(causeOf(a), 'cloud rejecting our requests (check host clock)');
});

test('every panel cause renders its own title and Cause fact, all at the same severity', () => {
  const expected: Record<PollFailure['cause'], [string, string]> = {
    'shp2-content-frozen': ['Panel data is stale — grid presence unknown', 'cloud replaying a stale copy of the panel'],
    'shp2-fetch-failed': ['Panel is not answering — grid presence unconfirmed', 'panel fetch failing'],
    'shp2-not-polled': ['Panel is offline to the cloud — grid presence unconfirmed', 'cloud reports the panel offline'],
  };
  for (const [cause, [title, causeFact]] of Object.entries(expected) as Array<[PollFailure['cause'], [string, string]]>) {
    const v = blindVerdict({ cause, sns: ['SHP2-1'] });
    const [a] = telemetryBlindAlerts(v, NOW, blindAlertContext(fleet(), v.failure, NOW, { staleMs: CFG.staleMs }));
    assert.equal(a.title, title, cause);
    assert.equal(a.severity, 'critical', cause);
    assert.equal(a.priority, 'critical', cause);
    assert.equal(causeOf(a), causeFact, cause);
  }
});

test('★ the failure is bound to the failure that set lastError — a thrown poll clears it', () => {
  notePollFailed('SHP2 payload is a REPLAYED SHADOW — the fetch succeeded but the content is not moving (SHP2-1)', FROZEN);
  assert.deepEqual(pollState().lastFailure, FROZEN);
  notePollFailed('Connect Timeout Error (attempted address: api-a.ecoflow.com)');
  assert.equal(pollState().lastFailure, null,
    "a total outage must not inherit the previous tick's panel verdict and be described as one stale panel");
  notePollFailed('SHP2 quota fetch failed (SHP2-1)', { cause: 'shp2-fetch-failed', sns: ['SHP2-1'] });
  notePollOk(NOW);
  assert.equal(pollState().lastFailure, null, 'a healthy poll clears it');
});

test('★ "other devices reporting" excludes the named panel, replays, Cores outside the home pool and anything not current', () => {
  const ctx = blindAlertContext({
    'SHP2-1': { deviceName: 'Smart Home Panel 2', online: true, lastQuotaAtMs: NOW, projection: { kind: 'shp2' } },
    'DPU-1': { online: true, lastQuotaAtMs: NOW - 10_000, projection: { kind: 'dpu' } },                       // counts
    'DPU-2': { online: true, lastQuotaAtMs: NOW - 6 * MIN, projection: { kind: 'dpu' } },                      // stale
    'DPU-3': { online: false, lastQuotaAtMs: NOW, projection: { kind: 'dpu' } },                               // offline
    'SMALL': { online: true, lastQuotaAtMs: NOW, projection: { kind: 'generic' } },                            // not an alarm source
    'DPU-4': { online: true, lastUpdated: NOW, lastQuotaAtMs: NOW - 30 * MIN, projection: { kind: 'dpu' } },   // a flip, no telemetry
    'DPU-5': { online: true, projection: null },
    'SHP2-2': { online: true, lastQuotaAtMs: NOW, contentStaleSinceMs: NOW - 10 * MIN, projection: { kind: 'shp2' } }, // a replay, not a report
    'BENCH': { online: true, lastQuotaAtMs: NOW, projection: { kind: 'dpu' } },                                         // bench hardware
    'SHP2-3': { online: true, lastQuotaAtMs: NOW, projection: { kind: 'shp2' } },                                        // a panel is never 'outside the pool'
  }, FROZEN, NOW, { staleMs: CFG.staleMs, isOutsideHomePool: (sn) => sn === 'BENCH' || sn === 'SHP2-3' });
  assert.deepEqual(ctx, { affectedNames: ['Smart Home Panel 2'], otherReportingCount: 2 },
    'DPU-1 and the healthy second panel; the pool predicate applies to Cores only');
});

test('★ BRIDGE: the poll loop hands its verdict to notePollFailed, and the alert monitor renders with context', () => {
  // Both call sites sit inside long closures with no injection seam, so this follows
  // the repo's convention for unreachable call sites (cf. auditRound2's BRIDGE pin).
  // Without either, every function above stays correct and nothing changes live.
  const __dir = dirname(fileURLToPath(import.meta.url));
  const snap = readFileSync(resolve(__dir, '../src/snapshot.ts'), 'utf8');
  const i = snap.indexOf("health.reason === 'shp2-fetch-failed'");
  assert.ok(i > 0, 'the poll-loop failure message must still be findable');
  const call = snap.slice(i, snap.indexOf(');', i));
  assert.match(call, /\{ cause: health\.reason, sns: health\.sns \},\s*$/, 'the verdict must travel with the failure');

  const mon = readFileSync(resolve(__dir, '../src/alertMonitor.ts'), 'utf8');
  assert.match(mon, /return telemetryBlindAlerts\(verdict, blindNowMs, blindAlertContext\(blindDevices, verdict\.failure, blindNowMs, \{ isOutsideHomePool: \(sn\) => isOutsideHomePool\(sn, blindDevices\) \}\)\);/,
    'the live alert must be rendered with the failure, the device map and the roster-aware pool predicate');
});

test('★ "outside the home pool" is roster-aware — the bench Core is out, a wired Core in the stale literal is in', () => {
  // The SPARE_DPU_SNS literal has been inverted since the 2026-08-20 swap: it names a
  // wired Core and not the bench unit. isBenchSpareSn can only REMOVE spare status from
  // it, so it could never exclude the real bench Core.
  const [literalSpare] = [...SPARE_DPU_SNS];
  assert.ok(literalSpare, 'precondition: the literal names at least one SN');
  try {
    setLastKnownHomeRoster(new Set(['CORE_1', literalSpare]));  // no SHP2 in the map, so the published roster decides
    assert.equal(isOutsideHomePool('CORE_3_BENCH', {}), true, 'a Core the roster does not name powers nothing in the house');
    assert.equal(isOutsideHomePool(literalSpare, {}), false, 'a wired Core still named in the stale literal is home');
    assert.equal(isOutsideHomePool('CORE_1', {}), false);
  } finally {
    resetLastKnownHomeRoster();
  }
});
