import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pollHealthVerdict, alarmPathShp2Sns } from '../src/snapshot.js';

/**
 * v1.138.0 / v1.139.0 — "was this poll evidence the alarm path can still see?"
 *
 * ROOT CAUSE, shared by two detectors: `refreshAll` fetches only
 * `list.filter(d => d.online === 1)`, so `failedSns` can only ever contain
 * devices the poll actually ASKED. Absence from it has three causes and only one
 * is success — it succeeded, it went offline and was never asked, or it fell out
 * of `/device/list`. Both detectors read absence as success.
 *
 * The consumer-facing one (the v1.88.0 enablement doorbell) fired live on
 * 2026-09-08: BACC - Delta 3 Plus went cloud-OFFLINE and 302 ms later the panel
 * pushed "EcoFlow data restored" to the operator's phone. That detector is now
 * DELETED (v1.139.0) — see the regression pin at the bottom of this file.
 *
 * `pollHealthVerdict` is the half that mattered and survives. The same inference
 * was applied to the SHP2, where a cloud-offline panel left `notePollOk()`
 * running and the telemetry-blind CRITICAL disarmed for the entire dark window.
 */

const SHP2 = 'HD31ZAB1ZH8Z0018';
const SHP2B = 'HD31ZAB1ZH8Z9999';
const BACC = 'P351ZA1APH6G0413';
const PWRI = 'HT31ZAB51G760667';

test('★ S1: an SHP2 that was never polled is NOT a healthy poll', () => {
  // THE DEFECT: `failedSns.some(isShp2)` was false for a cloud-offline SHP2, so
  // notePollOk() ran. assessBlind's other input counts devices carrying a
  // projection regardless of `online`, and setDeviceList PRESERVES projection
  // across the transition — so the detector saw a fresh poll and a populated
  // fleet and stayed disarmed. The alarm system stopped watching the alarm path
  // and reported itself healthy.
  const v = pollHealthVerdict({
    knownShp2Sns: [SHP2],
    attemptedSns: [BACC, PWRI],
    failedSns: [BACC, PWRI],
  });
  assert.equal(v.ok, false);
  assert.equal(v.ok === false && v.reason, 'shp2-not-polled');
  assert.deepEqual(v.ok === false && v.sns, [SHP2]);
});

test('S1: an SHP2 that was asked and failed is still caught (v1.86.0 behaviour kept)', () => {
  const v = pollHealthVerdict({ knownShp2Sns: [SHP2], attemptedSns: [SHP2], failedSns: [SHP2] });
  assert.equal(v.ok, false);
  assert.equal(v.ok === false && v.reason, 'shp2-fetch-failed');
});

test('S1: accessory-only failures still count the poll OK — pool data arrived', () => {
  // The steady state on this fleet: four 1006-blocked accessories fail every
  // single poll, permanently. If that made every poll unhealthy the telemetry-
  // blind CRITICAL would be pinned on forever.
  const v = pollHealthVerdict({
    knownShp2Sns: [SHP2],
    attemptedSns: [SHP2, BACC, PWRI],
    failedSns: [BACC, PWRI],
  });
  assert.equal(v.ok, true);
});

test('S1: bootstrap fails OPEN — blindness cannot be asserted before any SHP2 is known', () => {
  // Before the first quota response there is no projection, so no SHP2 is known.
  // Asserting blindness here would raise a CRITICAL on every cold boot.
  const v = pollHealthVerdict({ knownShp2Sns: [], attemptedSns: [], failedSns: [] });
  assert.equal(v.ok, true);
});

test('★ S1: a PARTIALLY dark multi-panel fleet is partial blindness', () => {
  // v1.129.0 exists because this fleet can have two panels, and a second panel
  // going dark silently unmonitors its DPUs. some/every is the whole difference:
  // one healthy panel must not vouch for a dark one.
  const v = pollHealthVerdict({ knownShp2Sns: [SHP2, SHP2B], attemptedSns: [SHP2], failedSns: [] });
  assert.equal(v.ok, false);
  assert.equal(v.ok === false && v.reason, 'shp2-not-polled');
  assert.deepEqual(v.ok === false && v.sns, [SHP2B]);
});

test('S1: a failed SHP2 outranks an unasked one, so the log names the real error', () => {
  const v = pollHealthVerdict({ knownShp2Sns: [SHP2, SHP2B], attemptedSns: [SHP2], failedSns: [SHP2] });
  assert.equal(v.ok === false && v.reason, 'shp2-fetch-failed');
});

// ── the production bridge ────────────────────────────────────────────────────
/**
 * `pollHealthVerdict` being correct proves nothing if `tick()` hands it the
 * wrong arguments. The mutation harness found exactly that. `refreshAll` calls
 * the module-level `ecoflow` singleton with no injection seam, so this is a
 * source pin — the convention this repo uses for un-reachable closures (cf. the
 * availability test in mqttDiscovery.test.ts).
 */
test('★ BRIDGE: refreshAll derives attemptedSns from the ONLINE-filtered list', () => {
  const __dir = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(resolve(__dir, '../src/snapshot.ts'), 'utf8');
  // If this reads `list.map`, an offline device is claimed as asked and the
  // defect returns at its source.
  assert.match(
    src,
    /const online = list\.filter\(\(d\) => d\.online === 1\);\s*\n\s*const attemptedSns = online\.map\(\(d\) => d\.sn\);/,
    'attemptedSns must come from the online-filtered set, never the raw device list',
  );
});

test('★ BRIDGE: the live tick passes the real attempt set to pollHealthVerdict', () => {
  const __dir = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(resolve(__dir, '../src/snapshot.ts'), 'utf8');
  const i = src.indexOf('pollHealthVerdict({');
  assert.ok(i > 0, 'pollHealthVerdict call site located');
  const call = src.slice(i, src.indexOf('});', i));
  // Shorthand `attemptedSns,` — a colon means something else is being passed
  // under that name, which is exactly the pre-fix behaviour.
  assert.match(call, /\battemptedSns,/, 'S1 must receive the real attempt set');
  assert.ok(!/attemptedSns\s*:/.test(call), 'attemptedSns must not be aliased at this call site');
});

// ── regression pin: the doorbell stays deleted ───────────────────────────────
/**
 * v1.139.0 removed the v1.88.0 enablement doorbell outright. The premise it
 * rested on is false: API error 1006 is a PRODUCT-CLASS limit, not a grantable
 * account permission — settled by the owner on 2026-09-08, and consistent with
 * the vendor scoping the denial to the device ("current DEVICE is not allowed")
 * while the same credentials read every DPU and the SHP2 fine.
 *
 * So the condition it watched for cannot occur and every firing it could ever
 * produce is false. It is pinned rather than merely deleted because the repo
 * previously asserted BOTH readings of 1006 in different releases, and that
 * contradiction is what allowed the feature to be built in the first place.
 */
test('★ the enablement doorbell stays deleted', () => {
  const __dir = dirname(fileURLToPath(import.meta.url));
  const snap = readFileSync(resolve(__dir, '../src/snapshot.ts'), 'utf8');
  const index = readFileSync(resolve(__dir, '../src/index.ts'), 'utf8');

  for (const [name, src] of [['snapshot.ts', snap], ['index.ts', index]] as const) {
    for (const symbol of ['longFailureRecoveries', 'onLongFailureRecovered', 'failureFirstSeenMs']) {
      assert.ok(
        !src.includes(symbol),
        `${name} must not reintroduce ${symbol} — 1006 is a product-class limit, so this detector can only ever fire falsely`,
      );
    }
  }
  assert.ok(
    !index.includes("dedupId: 'ecoflow_data_restored'"),
    'the "EcoFlow data restored" push must not return — it made a false statement of fact about a life-safety system',
  );
  // The reasoning must survive the deletion, or someone rebuilds it.
  assert.match(snap, /PRODUCT-CLASS limit, not a grantable account/,
    'snapshot.ts must keep the tombstone explaining why the doorbell cannot exist');
});

// ── R1: the roster itself must not be filtered on the missing evidence ───────
/**
 * v1.140.0 — v1.138.0's own fix was half-closed. The roster was built as
 * `filter(sn => devices[sn]?.projection?.kind === 'shp2')`, but a projection
 * only exists after a SUCCESSFUL quota fetch and the store is in-memory. So
 * after any restart while the SHP2 is cloud-dark the roster is [] — not just at
 * bootstrap but for as long as the panel stays dark — pollHealthVerdict takes
 * its documented length===0 fail-open branch, and the telemetry-blind CRITICAL
 * is disarmed for the whole window. Exactly the outcome v1.138.0 prevented,
 * re-entered through the restart door. Measured: 9 restarts in one 50 h window.
 */
const dev = (o: Partial<Record<string, unknown>>) => o as never;

test('★ R1: a dark, never-hydrated SHP2 is still on the roster', () => {
  const devices = {
    [SHP2]: dev({ sn: SHP2, online: false, productName: 'Smart Home Panel 2' }), // no projection
    D1: dev({ sn: 'D1', online: true, productName: 'DELTA Pro Ultra', projection: { kind: 'dpu' } }),
  };
  assert.deepEqual(alarmPathShp2Sns(devices), [SHP2], 'identity, not projection');
  const v = pollHealthVerdict({
    knownShp2Sns: alarmPathShp2Sns(devices), attemptedSns: ['D1'], failedSns: [],
  });
  assert.equal(v.ok, false, 'the alarm path was not observed this poll');
  assert.equal(v.ok === false && v.reason, 'shp2-not-polled');
});

test('R1: a hydrated SHP2 is found by projection as well', () => {
  const devices = { [SHP2]: dev({ sn: SHP2, online: true, projection: { kind: 'shp2' } }) };
  assert.deepEqual(alarmPathShp2Sns(devices), [SHP2]);
});

test('R1: a DPU-only fleet still fails open — bootstrap preserved', () => {
  const devices = { D1: dev({ sn: 'D1', online: true, projection: { kind: 'dpu' } }) };
  assert.deepEqual(alarmPathShp2Sns(devices), []);
  assert.equal(pollHealthVerdict({ knownShp2Sns: [], attemptedSns: ['D1'], failedSns: [] }).ok, true);
});
