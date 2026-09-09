import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  longFailureRecoveries,
  pollHealthVerdict,
  LONG_FAILURE_TENURE_MS,
} from '../src/snapshot.js';

/**
 * v1.138.0 — a detector that fired about something it could not observe.
 *
 * This is the MIRROR of unreachableDetectors.test.ts. That file covers detectors
 * that cannot fire; this one covers a detector that fired on evidence it never
 * had. Both come from the same root: `failedSns` is built only from devices the
 * poll actually ASKED (`list.filter(d => d.online === 1)`), and two call sites
 * read absence from it as success.
 *
 * THE LIVE INCIDENT (2026-09-08, epochs are the real log timestamps):
 *   1788907951591  BACC - Delta 3 Plus (P351ZA1APH6G0413) -> OFFLINE per EcoFlow Cloud
 *   1788907951893  "LONG-FAILING device fetch recovered — BACC - Delta 3 Plus"   [+302 ms]
 *   1788908011596  -> ONLINE again                                               [+59.7 s]
 *   1788908011926  back in a 4-failure set
 * The operator's phone said "EcoFlow data restored — quota data is flowing
 * again". That SN's `lastUpdated` was 0 then and is 0 now: no quota fetch has
 * ever succeeded for it. The device DISAPPEARING produced a restoration alert.
 */

const BACC = 'P351ZA1APH6G0413';
const PWRI = 'HT31ZAB51G760667';
const RIV3 = 'R631ZABAWH1S0633';
const EVSE = 'C101ZA1AZH5A0266';
const OFFLINE_AT = 1788907951591;
const DOORBELL_AT = 1788907951893;

// ── longFailureRecoveries ────────────────────────────────────────────────────

test('★ INCIDENT REPLAY: an offline device is NOT a recovery', () => {
  // BACC had been failing ~36 min, then went offline. The other three were
  // asked and failed as usual. Under the old `!failedSns.includes(sn)` test
  // this returned [BACC] and pushed "data restored" to a phone.
  const tenure = new Map([
    [BACC, OFFLINE_AT - 36 * 60_000],
    [PWRI, OFFLINE_AT - 40 * 60_000],
    [RIV3, OFFLINE_AT - 40 * 60_000],
    [EVSE, OFFLINE_AT - 40 * 60_000],
  ]);
  const out = longFailureRecoveries({
    nowMs: DOORBELL_AT,
    tenureMs: tenure,
    attemptedSns: [PWRI, RIV3, EVSE], // BACC was offline — never asked
    failedSns: [PWRI, RIV3, EVSE],
  });
  assert.deepEqual(out, [], 'a device that was never polled cannot have recovered');
});

test('★ INCIDENT REPLAY: the held device keeps its clock, so it does not re-arm', () => {
  // The old code deleted the entry on every absence, outside the tenure test.
  // That restarted the clock at 15:53:31 and re-armed the doorbell to fire
  // again on the next flap — and would have SILENCED a genuine enablement that
  // landed during an offline window, since the device would return succeeding
  // and never re-accumulate 30 minutes of failure.
  const since = OFFLINE_AT - 36 * 60_000;
  const tenure = new Map([[BACC, since]]);
  longFailureRecoveries({ nowMs: DOORBELL_AT, tenureMs: tenure, attemptedSns: [], failedSns: [] });
  assert.equal(tenure.get(BACC), since, 'tenure must be HELD, not reset and not deleted');
});

test('a genuine recovery still rings, and retires its entry', () => {
  const tenure = new Map([[BACC, 1_000]]);
  const out = longFailureRecoveries({
    nowMs: 1_000 + LONG_FAILURE_TENURE_MS,
    tenureMs: tenure,
    attemptedSns: [BACC],
    failedSns: [],
  });
  assert.deepEqual(out, [BACC]);
  assert.equal(tenure.has(BACC), false, 'a fired entry is retired so it cannot re-fire');
});

test('tenure SURVIVES an offline gap and fires once on the real return', () => {
  const MIN = 60_000;
  const tenure = new Map([[BACC, 0]]);
  // Minutes 1-25: asked, and failing. The clock accrues from 0.
  for (let i = 1; i <= 25; i++) {
    assert.deepEqual(
      longFailureRecoveries({ nowMs: i * MIN, tenureMs: tenure, attemptedSns: [BACC], failedSns: [BACC] }),
      [], `poll ${i} is still failing`,
    );
  }
  // Minutes 26-45: cloud-offline, so never asked. Silent, and HELD — the old
  // code deleted the entry on the first of these, which both re-armed the
  // doorbell and destroyed the tenure a genuine enablement would have needed.
  for (let i = 26; i <= 45; i++) {
    assert.deepEqual(
      longFailureRecoveries({ nowMs: i * MIN, tenureMs: tenure, attemptedSns: [], failedSns: [] }),
      [], `poll ${i} is unevaluable`,
    );
    assert.equal(tenure.get(BACC), 0, `poll ${i} must not reset the clock`);
  }
  // Minute 46: it returns and succeeds. Tenure still runs from 0, so it is well
  // past the 30-minute gate and this rings — no fresh 30-minute wait imposed by
  // the outage. Under the old code the entry was gone and this would be silent.
  assert.deepEqual(
    longFailureRecoveries({ nowMs: 46 * MIN, tenureMs: tenure, attemptedSns: [BACC], failedSns: [] }),
    [BACC],
  );
});

test('a SHORT real recovery is silent, but still retires its entry', () => {
  const tenure = new Map([[BACC, 0]]);
  const out = longFailureRecoveries({
    nowMs: 29 * 60_000, tenureMs: tenure, attemptedSns: [BACC], failedSns: [],
  });
  assert.deepEqual(out, []);
  assert.equal(tenure.has(BACC), false, 'it recovered — it is just not newsworthy');
});

test('the tenure boundary is >=, matching the slowMs convention', () => {
  const mk = () => new Map([[BACC, 0]]);
  assert.deepEqual(
    longFailureRecoveries({ nowMs: LONG_FAILURE_TENURE_MS, tenureMs: mk(), attemptedSns: [BACC], failedSns: [] }),
    [BACC],
  );
  assert.deepEqual(
    longFailureRecoveries({ nowMs: LONG_FAILURE_TENURE_MS - 1, tenureMs: mk(), attemptedSns: [BACC], failedSns: [] }),
    [],
  );
});

test('★ an EMPTY device list announces nothing and clears nothing', () => {
  // The second, unguarded doorbell site fired for every long-tenured SN at once
  // when failedSns was empty, then .clear()'d the map. /device/list has no
  // length validation, so a short or empty vendor response would have pushed
  // one message naming all four 1006-blocked accessories as restored — a
  // telemetry blackout rendered as good news.
  const tenure = new Map([[BACC, 0], [PWRI, 0], [RIV3, 0], [EVSE, 0]]);
  const out = longFailureRecoveries({
    nowMs: 10 * LONG_FAILURE_TENURE_MS, tenureMs: tenure, attemptedSns: [], failedSns: [],
  });
  assert.deepEqual(out, []);
  assert.equal(tenure.size, 4, 'every entry is held — none announced, none dropped');
});

test('a fired recovery does not fire again on the next poll', () => {
  const tenure = new Map([[BACC, 0]]);
  const first = longFailureRecoveries({
    nowMs: LONG_FAILURE_TENURE_MS, tenureMs: tenure, attemptedSns: [BACC], failedSns: [],
  });
  assert.deepEqual(first, [BACC]);
  const second = longFailureRecoveries({
    nowMs: LONG_FAILURE_TENURE_MS + 60_000, tenureMs: tenure, attemptedSns: [BACC], failedSns: [],
  });
  assert.deepEqual(second, []);
});

test('a healthy device never seen failing produces nothing', () => {
  // Guards has/includes polarity: a success for an SN with no tenure entry
  // must not be reported as a recovery.
  const tenure = new Map<string, number>();
  const out = longFailureRecoveries({
    nowMs: 10 * LONG_FAILURE_TENURE_MS, tenureMs: tenure, attemptedSns: [BACC], failedSns: [],
  });
  assert.deepEqual(out, []);
  assert.equal(tenure.size, 0);
});

test('the first observed failure starts the clock and does not fire on that tick', () => {
  const tenure = new Map<string, number>();
  const out = longFailureRecoveries({
    nowMs: 5_000, tenureMs: tenure, attemptedSns: [BACC], failedSns: [BACC],
  });
  assert.deepEqual(out, []);
  assert.equal(tenure.get(BACC), 5_000);
});

test('a still-failing device keeps its ORIGINAL clock, not a refreshed one', () => {
  const tenure = new Map([[BACC, 1_000]]);
  longFailureRecoveries({ nowMs: 900_000, tenureMs: tenure, attemptedSns: [BACC], failedSns: [BACC] });
  assert.equal(tenure.get(BACC), 1_000, 'tenure accrues from the FIRST failure');
});

// ── pollHealthVerdict (S1) ───────────────────────────────────────────────────

const SHP2 = 'HD31ZAB1ZH8Z0018';

test('★ S1: an SHP2 that was never polled is NOT a healthy poll', () => {
  // THE DEFECT: `failedSns.some(isShp2)` was false for a cloud-offline SHP2,
  // so notePollOk() ran. assessBlind's other input counts devices carrying a
  // projection regardless of `online`, and setDeviceList PRESERVES projection
  // across the transition — so the telemetry-blind CRITICAL saw a fresh poll
  // and a populated fleet, and stayed disarmed for the whole dark window.
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
  const v = pollHealthVerdict({
    knownShp2Sns: [SHP2],
    attemptedSns: [SHP2, BACC, PWRI, RIV3, EVSE],
    failedSns: [BACC, PWRI, RIV3, EVSE],
  });
  assert.equal(v.ok, true);
});

test('S1: bootstrap fails OPEN — blindness cannot be asserted before any SHP2 is known', () => {
  // Before the first quota response there is no projection, so no SHP2 is
  // known. Asserting blindness there would fire a CRITICAL on every cold boot.
  const v = pollHealthVerdict({ knownShp2Sns: [], attemptedSns: [], failedSns: [] });
  assert.equal(v.ok, true);
});

test('★ S1: a PARTIALLY dark multi-panel fleet is partial blindness', () => {
  // v1.129.0 exists because this fleet can have two panels, and a second panel
  // going dark silently unmonitors its DPUs. `some`/`every` is the whole
  // difference: one healthy panel must not vouch for a dark one.
  const SHP2B = 'HD31ZAB1ZH8Z9999';
  const v = pollHealthVerdict({
    knownShp2Sns: [SHP2, SHP2B],
    attemptedSns: [SHP2],
    failedSns: [],
  });
  assert.equal(v.ok, false);
  assert.equal(v.ok === false && v.reason, 'shp2-not-polled');
  assert.deepEqual(v.ok === false && v.sns, [SHP2B]);
});

test('S1: a failed SHP2 is reported as failed even when another is also unasked', () => {
  // Ordering: the harder-evidence reason wins, so the log names the real error.
  const SHP2B = 'HD31ZAB1ZH8Z9999';
  const v = pollHealthVerdict({
    knownShp2Sns: [SHP2, SHP2B],
    attemptedSns: [SHP2],
    failedSns: [SHP2],
  });
  assert.equal(v.ok === false && v.reason, 'shp2-fetch-failed');
});

// ── the production bridge ────────────────────────────────────────────────────
/**
 * Both detectors above are pure and fully covered — and that proves nothing
 * about the add-on if `tick()` hands them the wrong arguments. The mutation
 * harness found exactly that: three mutants that leave every test green while
 * making the real poll loop behave as it did BEFORE the fix.
 *
 * This is the failure mode the repo already has a name for: v0.33 shipped a
 * dead `M` key that was wired, tested and mutation-proven while the production
 * source literal omitted it. `refreshAll` and the `tick` closure are not
 * reachable from a test — `refreshAll` calls the module-level `ecoflow`
 * singleton with no injection seam, and `failureFirstSeenMs` is a closure-local
 * const — so these are source pins, the convention this repo uses for exactly
 * that situation (cf. the availability test in mqttDiscovery.test.ts).
 */
test('★ BRIDGE: refreshAll derives attemptedSns from the ONLINE-filtered list', () => {
  const __dir = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(resolve(__dir, '../src/snapshot.ts'), 'utf8');

  // If this reads `list.map`, an offline device is claimed as asked and BOTH
  // defects come back at their source — one edit re-breaks everything downstream.
  assert.match(
    src,
    /const online = list\.filter\(\(d\) => d\.online === 1\);\s*\n\s*const attemptedSns = online\.map\(\(d\) => d\.sn\);/,
    'attemptedSns must be derived from the online-filtered set, never from the raw device list',
  );
});

test('★ BRIDGE: the live tick passes the real attempt set to both detectors', () => {
  const __dir = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(resolve(__dir, '../src/snapshot.ts'), 'utf8');

  const doorbell = src.slice(
    src.indexOf('longFailureRecoveries({'),
    src.indexOf('});', src.indexOf('longFailureRecoveries({')),
  );
  assert.ok(doorbell.length > 0, 'longFailureRecoveries call site located');
  // Shorthand `attemptedSns,` — a colon means something else is being passed
  // under that name (the harness mutant substitutes failedSns).
  assert.match(doorbell, /\battemptedSns,/, 'the doorbell must receive the real attempt set');
  assert.ok(
    !/attemptedSns\s*:/.test(doorbell),
    'attemptedSns must not be aliased to another variable at the doorbell call site',
  );

  const verdict = src.slice(
    src.indexOf('pollHealthVerdict({'),
    src.indexOf('});', src.indexOf('pollHealthVerdict({')),
  );
  assert.ok(verdict.length > 0, 'pollHealthVerdict call site located');
  assert.match(verdict, /\battemptedSns,/, 'S1 must receive the real attempt set');
  assert.ok(
    !/attemptedSns\s*:/.test(verdict),
    'attemptedSns must not be aliased at the pollHealthVerdict call site — that restores the pre-fix behaviour exactly',
  );
});
