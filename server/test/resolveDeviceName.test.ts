import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDeviceName } from '../src/snapshot.js';

// v0.75.0 — EcoFlow's /device/list returns deviceName === sn when the owner never
// set a friendly name, leaking the raw serial into the UI and the recurring
// "<SN> is flagged offline" info-alert. resolveDeviceName conservatively falls
// back to the product type ONLY when the cloud name is missing or is just the SN.

test('real name is kept verbatim', () => {
  assert.equal(resolveDeviceName('Core 1', 'DELTA Pro Ultra', 'GBC0314'), 'Core 1');
});

test('bare-SN deviceName falls back to productName (live WAVE 2 case)', () => {
  // KT21ZAH4HG160047 has deviceName == its own SN but productName == "WAVE 2".
  assert.equal(
    resolveDeviceName('KT21ZAH4HG160047', 'WAVE 2', 'KT21ZAH4HG160047'),
    'WAVE 2',
  );
});

test('missing name falls back to productName', () => {
  assert.equal(resolveDeviceName(undefined, 'WAVE 2', 'KT21ZAH4HG160047'), 'WAVE 2');
  assert.equal(resolveDeviceName(null, 'WAVE 2', 'KT21ZAH4HG160047'), 'WAVE 2');
  assert.equal(resolveDeviceName('', 'WAVE 2', 'KT21ZAH4HG160047'), 'WAVE 2');
});

test('neither a real name nor a product → falls back to the SN', () => {
  assert.equal(resolveDeviceName('KT21ZAH4HG160047', undefined, 'KT21ZAH4HG160047'), 'KT21ZAH4HG160047');
  assert.equal(resolveDeviceName('', '', 'KT21ZAH4HG160047'), 'KT21ZAH4HG160047');
  assert.equal(resolveDeviceName(null, null, 'KT21ZAH4HG160047'), 'KT21ZAH4HG160047');
});

test('whitespace-padded name that equals the SN is treated as bare-SN', () => {
  assert.equal(resolveDeviceName('  KT21ZAH4HG160047  ', 'WAVE 2', 'KT21ZAH4HG160047'), 'WAVE 2');
});
