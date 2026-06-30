import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyMqttStartFailure } from '../src/mqttStartClassify.js';

const GRACE = 5;

test('classifyMqttStartFailure — boot-window DNS/8521 failures log at warn', () => {
  for (const msg of [
    'getaddrinfo EAI_AGAIN api-a.ecoflow.com',
    'getaddrinfo ENOTFOUND mqtt.ecoflow.com',
    'EcoFlow API error 8521: signature is wrong',
    'signature is wrong (trace )',
  ]) {
    assert.equal(classifyMqttStartFailure(0, msg, GRACE), 'warn', msg);
    assert.equal(classifyMqttStartFailure(4, msg, GRACE), 'warn', `${msg} @ attempt 4`);
  }
});

test('classifyMqttStartFailure — the SAME transient PAST the grace window escalates to error', () => {
  const msg = 'getaddrinfo EAI_AGAIN api-a.ecoflow.com';
  assert.equal(classifyMqttStartFailure(5, msg, GRACE), 'error'); // attempt 5 == grace → no longer transient
  assert.equal(classifyMqttStartFailure(9, msg, GRACE), 'error');
});

test('classifyMqttStartFailure — a NON-transient error class is error even on the first attempt', () => {
  for (const msg of [
    'ECONNREFUSED 127.0.0.1:1883',
    'certificate has expired',
    'Unexpected token in JSON',
    'broker closed connection',
  ]) {
    assert.equal(classifyMqttStartFailure(0, msg, GRACE), 'error', msg);
  }
});

test('classifyMqttStartFailure — case-insensitive match', () => {
  assert.equal(classifyMqttStartFailure(0, 'eai_again', GRACE), 'warn');
  assert.equal(classifyMqttStartFailure(0, 'SIGNATURE IS WRONG', GRACE), 'warn');
});

test('classifyMqttStartFailure — grace boundary is strict (< graceAttempts)', () => {
  const msg = '8521 signature is wrong';
  assert.equal(classifyMqttStartFailure(0, msg, 1), 'warn'); // attempt 0 < 1
  assert.equal(classifyMqttStartFailure(1, msg, 1), 'error'); // attempt 1 == 1 → error
  assert.equal(classifyMqttStartFailure(0, msg, 0), 'error'); // grace 0 → never transient
});
