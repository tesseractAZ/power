import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyDeviceLink,
  deviceReachabilityEntities,
  hasReachabilityConfig,
  interpretReachabilityState,
  setDeviceReachability,
  getDeviceReachability,
  countCloudWedges,
  type Reachability,
} from '../src/deviceLink.js';

/* ===================================================================
 * Cloud-wedge vs real-outage device-link classification.
 *
 * The classifier is the load-bearing piece: it decides whether an
 * EcoFlow-cloud-offline device is a benign cloud-session wedge (still
 * reachable on the LAN, telemetry resumes on its own) or a genuine
 * power/network outage (LAN-unreachable, needs a power/breaker/WiFi
 * check). It must be pure + total over the full (cloudOnline × reachable)
 * matrix, and the env parser must degrade to {} on any bad input so the
 * feature stays dormant rather than crashing the loop.
 * =================================================================== */

// ── classifyDeviceLink: exhaustive (cloudOnline × reachable) matrix ──────────

test('cloud online → "online" regardless of reachability', () => {
  for (const r of ['up', 'down', 'unknown'] as Reachability[]) {
    assert.equal(classifyDeviceLink(true, r), 'online', `online + ${r}`);
  }
});

test('cloud offline + reachable up → "cloud_wedge"', () => {
  assert.equal(classifyDeviceLink(false, 'up'), 'cloud_wedge');
});

test('cloud offline + reachable down → "real_outage"', () => {
  assert.equal(classifyDeviceLink(false, 'down'), 'real_outage');
});

test('cloud offline + reachable unknown → "unknown"', () => {
  assert.equal(classifyDeviceLink(false, 'unknown'), 'unknown');
});

test('classifier is total — every (cloudOnline × reachable) combo is one of the 4 link states', () => {
  const valid = new Set(['online', 'cloud_wedge', 'real_outage', 'unknown']);
  for (const online of [true, false]) {
    for (const r of ['up', 'down', 'unknown'] as Reachability[]) {
      const link = classifyDeviceLink(online, r);
      assert.ok(valid.has(link), `(${online}, ${r}) → ${link}`);
    }
  }
});

// ── env parser: deviceReachabilityEntities / hasReachabilityConfig ───────────

function withEnv(value: string | undefined, fn: () => void): void {
  const prev = process.env.ECOFLOW_DEVICE_REACHABILITY;
  if (value === undefined) delete process.env.ECOFLOW_DEVICE_REACHABILITY;
  else process.env.ECOFLOW_DEVICE_REACHABILITY = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.ECOFLOW_DEVICE_REACHABILITY;
    else process.env.ECOFLOW_DEVICE_REACHABILITY = prev;
  }
}

test('parser: unset env → {} (dormant)', () => {
  withEnv(undefined, () => {
    assert.deepEqual(deviceReachabilityEntities(), {});
    assert.equal(hasReachabilityConfig(), false);
  });
});

test('parser: empty / whitespace string → {} (dormant)', () => {
  withEnv('', () => assert.deepEqual(deviceReachabilityEntities(), {}));
  withEnv('   ', () => assert.deepEqual(deviceReachabilityEntities(), {}));
});

test('parser: valid JSON object → trimmed SN→entity map; hasReachabilityConfig true', () => {
  withEnv('{"GBC0314":"binary_sensor.core1_lan"," GBC0482 ":" binary_sensor.core2_lan "}', () => {
    assert.deepEqual(deviceReachabilityEntities(), {
      GBC0314: 'binary_sensor.core1_lan',
      GBC0482: 'binary_sensor.core2_lan',
    });
    assert.equal(hasReachabilityConfig(), true);
  });
});

test('parser: malformed JSON → {} (dormant, no throw)', () => {
  withEnv('{not json', () => {
    assert.deepEqual(deviceReachabilityEntities(), {});
    assert.equal(hasReachabilityConfig(), false);
  });
  withEnv('GBC0314=binary_sensor.core1_lan', () => assert.deepEqual(deviceReachabilityEntities(), {}));
});

test('parser: non-object JSON (array / number / string / null) → {}', () => {
  withEnv('["binary_sensor.core1_lan"]', () => assert.deepEqual(deviceReachabilityEntities(), {}));
  withEnv('42', () => assert.deepEqual(deviceReachabilityEntities(), {}));
  withEnv('"binary_sensor.core1_lan"', () => assert.deepEqual(deviceReachabilityEntities(), {}));
  withEnv('null', () => assert.deepEqual(deviceReachabilityEntities(), {}));
});

test('parser: drops entries with non-string or empty values (no poisoning)', () => {
  withEnv('{"GBC0314":"binary_sensor.core1_lan","BAD1":null,"BAD2":123,"BAD3":"","GBC0482":"binary_sensor.core2_lan"}', () => {
    assert.deepEqual(deviceReachabilityEntities(), {
      GBC0314: 'binary_sensor.core1_lan',
      GBC0482: 'binary_sensor.core2_lan',
    });
  });
});

// ── interpretReachabilityState: HA ping binary_sensor convention ─────────────

test('interpret: connectivity "on" / home / connected / true → up', () => {
  for (const s of ['on', 'ON', 'home', 'connected', 'true', 'up', 'reachable', 'online', 'yes']) {
    assert.equal(interpretReachabilityState(s), 'up', s);
  }
});

test('interpret: "off" / not_home / disconnected / false → down', () => {
  for (const s of ['off', 'OFF', 'not_home', 'disconnected', 'false', 'down', 'unreachable', 'offline', 'no']) {
    assert.equal(interpretReachabilityState(s), 'down', s);
  }
});

test('interpret: unavailable / unknown / empty / null / garbage → unknown', () => {
  for (const s of ['unavailable', 'unknown', 'none', '', '   ', 'wat', null, undefined]) {
    assert.equal(interpretReachabilityState(s as any), 'unknown', String(s));
  }
});

// ── reachability cache: set / get with safe default ──────────────────────────

test('cache: getDeviceReachability defaults to "unknown" for an unseen SN', () => {
  assert.equal(getDeviceReachability('NEVER_SET_SN'), 'unknown');
});

test('cache: set then get round-trips and overwrites', () => {
  setDeviceReachability('CACHE_SN', 'up');
  assert.equal(getDeviceReachability('CACHE_SN'), 'up');
  setDeviceReachability('CACHE_SN', 'down');
  assert.equal(getDeviceReachability('CACHE_SN'), 'down');
  setDeviceReachability('CACHE_SN', 'unknown');
  assert.equal(getDeviceReachability('CACHE_SN'), 'unknown');
});

// ── countCloudWedges: only cloud-offline + LAN-up devices count ──────────────

test('countCloudWedges: counts only cloud-offline + reachable-up devices', () => {
  const devices = [
    { sn: 'A', online: false }, // up   → cloud_wedge ✓
    { sn: 'B', online: false }, // down → real_outage
    { sn: 'C', online: false }, // unknown → unknown
    { sn: 'D', online: true }, // online (reachable irrelevant)
    { sn: 'E', online: false }, // up   → cloud_wedge ✓
  ];
  const reach: Record<string, Reachability> = { A: 'up', B: 'down', C: 'unknown', D: 'up', E: 'up' };
  assert.equal(countCloudWedges(devices, (sn) => reach[sn] ?? 'unknown'), 2);
});

test('countCloudWedges: 0 when no reachability configured (all → unknown)', () => {
  const devices = [
    { sn: 'A', online: false },
    { sn: 'B', online: false },
    { sn: 'C', online: true },
  ];
  // Default lookup → 'unknown' for every SN → no cloud_wedge.
  assert.equal(countCloudWedges(devices, () => 'unknown'), 0);
});

test('countCloudWedges: empty fleet → 0', () => {
  assert.equal(countCloudWedges([], () => 'up'), 0);
});
