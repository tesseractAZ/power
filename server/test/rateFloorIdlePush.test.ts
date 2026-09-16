import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  pushDwellStart, pushDebounceMsFor, decideAlertDispatch, MSG_RATE_PUSH_DEBOUNCE_MS,
} from '../src/alertMonitor.js';
import {
  setRateFloorIdleHeld, rateFloorIdleHeldIds, resetRateFloorCollapses, rateFloorAlertId,
} from '../src/messageRateFloorAlert.js';

/**
 * v1.158.0 — a rate collapse HELD on an idle, non-alarm-path device must not page.
 *
 * 2026-09-13: three packs' collapses surfaced at 21:31 while discharging; the 21:35 session
 * rebuild worked (panel back to 31 msg/min at 21:41); the packs reached the reserve floor at
 * ~21:37 and went idle. A surfaced collapse is held through idleness, and an idle pack at
 * ~4.7 msg/min cannot clear the 10 msg/min recovery bar — so the 20-minute push dwell expired
 * against a healthy session and three "[Medium] Device barely reporting" cards pushed at
 * 21:51, telling the operator to check the cloud session and power. They stood until the packs
 * woke at 07:04-07:29. v1.157.0 removed the heal VOTE for such a device; this removes the PUSH,
 * and only the push: the card is unchanged, and the alarm-path panel is never held.
 */

const MIN = 60_000;
const T0 = Date.UTC(2026, 8, 14, 4, 31); // 21:31 MST — the collapse
const PANEL = 'PANEL';
const CORE = 'CORE-A';

const src = (f: string) =>
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/', f), 'utf8');

// ── the dwell clock ──────────────────────────────────────────────────────────

test('★ an idle-held collapse re-bases the push dwell every tick', () => {
  assert.equal(pushDwellStart({ firstSeen: T0 }, true, T0 + 5 * MIN), T0 + 5 * MIN);
  assert.equal(pushDwellStart({ firstSeen: T0, dwellFrom: T0 }, true, T0 + 9 * MIN), T0 + 9 * MIN);
});

test('an alert that is never idle-held keeps its original dwell start', () => {
  assert.equal(pushDwellStart({ firstSeen: T0 }, false, T0 + 5 * MIN), T0, 'falls back to firstSeen');
  assert.equal(pushDwellStart({ firstSeen: T0, dwellFrom: T0 + 3 * MIN }, false, T0 + 9 * MIN), T0 + 3 * MIN,
    'once re-based, the dwell runs from where idleness ended — it does not jump back');
});

test('★★★ THE 09-13 SHAPE: held while idle, then earned again once active', () => {
  // One tick per minute from the collapse. The pack is active until it reaches the floor at
  // m=6 (21:37), idle-held until it wakes at m=560 (07:11), then active and still starved.
  const state = { firstSeen: T0, dwellFrom: undefined as number | undefined };
  const pushedAt: number[] = [];
  let notified = false;
  for (let m = 0; m <= 620; m++) {
    const now = T0 + m * MIN;
    const idleHeld = m >= 6 && m < 560; // last idle observation is m=559
    state.dwellFrom = pushDwellStart(state, idleHeld, now);
    const action = decideAlertDispatch({
      qualifies: true,
      alreadyNotified: notified,
      alreadyQueued: false,
      escalated: false,
      debounceElapsed: now - state.dwellFrom >= pushDebounceMsFor(rateFloorAlertId(CORE), MIN),
      inQuiet: false,
      breaksThrough: false,
    });
    if (action === 'dispatch') { pushedAt.push(m); notified = true; }
  }
  // 20 minutes after the dwell was last re-based (m=559, the final idle tick) — i.e. the pack
  // has been active and still starved for the whole dwell before the operator is paged.
  assert.deepEqual(pushedAt, [579], 'silent through the idle night; pages 20 min after the pack is active again');
  assert.ok(!pushedAt.includes(20), 'the 21:51 push that told the operator to check a healthy session is gone');
  assert.ok(pushedAt[0] - 560 >= 19, 'the dwell is re-earned against an active device, not inherited from the idle hours');
});

test('a collapse that never idles still pages on the unchanged 20-minute dwell', () => {
  const state = { firstSeen: T0, dwellFrom: undefined as number | undefined };
  const at: number[] = [];
  let notified = false;
  for (let m = 0; m <= 40; m++) {
    const now = T0 + m * MIN;
    state.dwellFrom = pushDwellStart(state, false, now);
    const action = decideAlertDispatch({
      qualifies: true, alreadyNotified: notified, alreadyQueued: false, escalated: false,
      debounceElapsed: now - state.dwellFrom >= MSG_RATE_PUSH_DEBOUNCE_MS,
      inQuiet: false, breaksThrough: false,
    });
    if (action === 'dispatch') { at.push(m); notified = true; }
  }
  assert.deepEqual(at, [20], 'the starvation family still pages at 20 minutes');
});

// ── the published set ────────────────────────────────────────────────────────

test('the idle-held registry is by alert id, and resets with the collapse set', () => {
  resetRateFloorCollapses();
  assert.equal(rateFloorIdleHeldIds().size, 0);
  setRateFloorIdleHeld([CORE, 'CORE-B']);
  const ids = rateFloorIdleHeldIds();
  assert.ok(ids.has(rateFloorAlertId(CORE)) && ids.has(rateFloorAlertId('CORE-B')));
  assert.ok(!ids.has(rateFloorAlertId(PANEL)), 'the alarm-path panel is never published as held');
  assert.equal(ids.size, 2);
  setRateFloorIdleHeld([]);
  assert.equal(rateFloorIdleHeldIds().size, 0, 'a tick with nothing idle clears the hold');
  setRateFloorIdleHeld([CORE]);
  resetRateFloorCollapses();
  assert.equal(rateFloorIdleHeldIds().size, 0, 'reset clears both sets');
});

// ── the production wiring ────────────────────────────────────────────────────

test('★★★ the tick publishes the quorum\'s own exclusions, and the dispatch honours them', () => {
  const idx = src('index.ts').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.ok(idx.includes('    setRateFloorIdleHeld(healQuorum.idleExcluded.map((m) => m.sn));'),
    'the push hold uses the same set as the heal quorum — so the alarm-path panel is excluded by identity');
  assert.ok(idx.includes('    setRateFloorCollapses(collapses);'), 'the CARD set stays unfiltered');

  const mon = src('alertMonitor.ts').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.match(mon, /const idleHeldPush = a\.id\.startsWith\('msg-rate-floor-'\) && rateFloorIdleHeldIds\(\)\.has\(a\.id\);/);
  assert.ok(mon.includes('      existing.dwellFrom = pushDwellStart(existing, idleHeldPush, now);'));
  assert.ok(mon.includes('        debounceElapsed: now - existing.dwellFrom >= escDebounceMs,'),
    'the dwell is measured from dwellFrom, never from firstSeen');
  assert.ok(!/debounceElapsed: now - existing\.firstSeen/.test(mon));
});
