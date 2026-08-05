import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assessBlind, classifyPollError, telemetryBlindAlerts,
  TELEMETRY_BLIND_ALERT_ID, type BlindInputs, type BlindConfig,
} from '../src/telemetryBlind.js';

/**
 * v1.69.0 — the 2026-08-04 blind outage. The add-on ran 22 minutes with an EMPTY
 * device map and zero telemetry while /api/health returned ok:true. Nothing alerted.
 */

const CFG: BlindConfig = {
  bootGraceMs: 3 * 60_000,
  staleMs: 5 * 60_000,
  authFailuresBeforeHeal: 5,
  healCooldownMs: 10 * 60_000,
};
const BOOT = Date.UTC(2026, 7, 4, 23, 21, 49);
const MIN = 60_000;

const inputs = (o: Partial<BlindInputs>): BlindInputs => ({
  nowMs: BOOT, bootMs: BOOT, projectedDeviceCount: 4,
  lastPollOkMs: BOOT, consecutiveFailures: 0, lastError: null, lastHealAtMs: null, ...o,
});

test('classifyPollError separates an auth rejection from a network outage', () => {
  assert.equal(classifyPollError('EcoFlow API error 8521: signature is wrong (trace )'), 'auth');
  assert.equal(classifyPollError('signature is wrong'), 'auth', 'matches the prose without the code');
  assert.equal(classifyPollError('getaddrinfo EAI_AGAIN api-a.ecoflow.com'), 'network');
  assert.equal(classifyPollError('Connect Timeout Error (attempted address: api-a...)'), 'network');
  assert.equal(classifyPollError(null), 'other');
});

test('a healthy system is not blind', () => {
  const v = assessBlind(inputs({ nowMs: BOOT + 30 * MIN, lastPollOkMs: BOOT + 30 * MIN }), CFG);
  assert.equal(v.blind, false);
});

test('THE INCIDENT: never-populated past the boot grace is BLIND', () => {
  const at = (min: number) => assessBlind(inputs({
    nowMs: BOOT + min * MIN, lastPollOkMs: null, projectedDeviceCount: 0,
    consecutiveFailures: min, lastError: 'EcoFlow API error 8521: signature is wrong (trace )',
  }), CFG);
  assert.equal(at(2).blind, false, 'a cold boot gets grace — no false alarm');
  const v = at(22); // the real duration
  assert.equal(v.blind, true);
  assert.equal(v.reason, 'never');
  assert.equal(v.errorKind, 'auth');
  assert.ok(v.blindForMs >= 22 * MIN);
});

test('stale telemetry (had data, lost it) is BLIND', () => {
  const v = assessBlind(inputs({
    nowMs: BOOT + 30 * MIN, lastPollOkMs: BOOT + 10 * MIN, projectedDeviceCount: 4,
    lastError: 'Connect Timeout Error',
  }), CFG);
  assert.equal(v.blind, true);
  assert.equal(v.reason, 'stale');
  assert.equal(v.errorKind, 'network');
});

test('★ a LEFTOVER device map does not count as sight', () => {
  // This is exactly how the outage hid: devices were still in the map from before,
  // so any "do we have devices?" check alone would have said yes.
  const v = assessBlind(inputs({
    nowMs: BOOT + 30 * MIN, lastPollOkMs: BOOT + 10 * MIN, projectedDeviceCount: 4,
  }), CFG);
  assert.equal(v.blind, true, 'stale polls beat a populated device map');
});

test('self-heal is recommended ONLY for auth failures, and is rate-limited', () => {
  const base = { nowMs: BOOT + 22 * MIN, lastPollOkMs: null, projectedDeviceCount: 0 };
  const auth = (o: Partial<BlindInputs> = {}) => assessBlind(inputs({
    ...base, consecutiveFailures: 9, lastError: 'EcoFlow API error 8521: signature is wrong', ...o,
  }), CFG);
  assert.equal(auth().shouldSelfHeal, true);
  assert.equal(auth({ consecutiveFailures: 2 }).shouldSelfHeal, false, 'needs sustained failures');
  assert.equal(auth({ lastHealAtMs: BOOT + 20 * MIN }).shouldSelfHeal, false, 'cooldown blocks a restart loop');
  // A network outage is not fixable by rebuilding the client.
  assert.equal(assessBlind(inputs({
    ...base, consecutiveFailures: 9, lastError: 'getaddrinfo EAI_AGAIN',
  }), CFG).shouldSelfHeal, false);
});

test('the alert is CRITICAL and names the clock when the cause is auth', () => {
  const v = assessBlind(inputs({
    nowMs: BOOT + 22 * MIN, lastPollOkMs: null, projectedDeviceCount: 0,
    consecutiveFailures: 22, lastError: 'EcoFlow API error 8521: signature is wrong',
  }), CFG);
  const [a] = telemetryBlindAlerts(v, BOOT + 22 * MIN);
  assert.equal(a.id, TELEMETRY_BLIND_ALERT_ID);
  assert.equal(a.severity, 'critical', 'silence here is the dangerous outcome');
  assert.match(a.detail, /clock/i, 'points at the clock, not the credentials');
  assert.match(a.detail, /cannot fire/i, 'says other alarms are disabled by this');
});

test('a healthy system produces NO alert', () => {
  const v = assessBlind(inputs({ nowMs: BOOT + 30 * MIN, lastPollOkMs: BOOT + 30 * MIN }), CFG);
  assert.deepEqual(telemetryBlindAlerts(v, BOOT + 30 * MIN), []);
});
