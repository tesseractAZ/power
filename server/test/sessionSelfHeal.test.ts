import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  evaluateSelfHeal, freshSelfHealState, utcDayKey, loadSelfHealState, saveSelfHealState,
  type SelfHealConfig,
} from '../src/sessionSelfHeal.js';

/**
 * v1.76.0 — the nightly starvation record: 43m, 69m, 5h15m, 11h47m, ~9h episodes
 * with recovery timing a lottery. The healer rebuilds our MQTT session after a
 * sustained fleet starvation; the cooldown + daily cap make it thrash-proof.
 */

const CFG: SelfHealConfig = { minStarvedDevices: 2, starvedForMs: 20 * 60_000, cooldownMs: 60 * 60_000, maxPerDay: 6 };
const T0 = Date.UTC(2026, 7, 10, 4, 0); // mid-day UTC so day-rollover tests control their own boundary
const MIN = 60_000;

test('a single starved device NEVER triggers a session rebuild', () => {
  const st = freshSelfHealState();
  for (let m = 0; m <= 120; m += 1) {
    assert.equal(evaluateSelfHeal(T0 + m * MIN, 1, st, CFG).heal, false);
  }
  assert.equal(st.starvedSinceMs, null, 'one flaky device does not even start the clock');
});

test('THE EPISODE: 3 Cores starved — heals exactly once the dwell elapses', () => {
  const st = freshSelfHealState();
  assert.equal(evaluateSelfHeal(T0, 3, st, CFG).heal, false, 'onset tick');
  assert.equal(evaluateSelfHeal(T0 + 10 * MIN, 3, st, CFG).heal, false, 'still dwelling');
  const v = evaluateSelfHeal(T0 + 20 * MIN, 3, st, CFG);
  assert.equal(v.heal, true);
  assert.match(v.reason, /3 devices starved 20m/);
  assert.equal(st.healTimesMs.length, 1); // v1.90.0 — rolling-window record
  assert.equal(st.starvedSinceMs, null, 'onset reset — the rebuild deserves time to work');
});

test('a recovery mid-dwell resets the clock — transients never heal', () => {
  const st = freshSelfHealState();
  evaluateSelfHeal(T0, 2, st, CFG);
  evaluateSelfHeal(T0 + 15 * MIN, 0, st, CFG); // recovered briefly
  assert.equal(st.starvedSinceMs, null);
  assert.equal(evaluateSelfHeal(T0 + 25 * MIN, 2, st, CFG).heal, false, 'dwell restarted');
  assert.equal(evaluateSelfHeal(T0 + 46 * MIN, 2, st, CFG).heal, true, 'full fresh dwell then heals');
});

test('cooldown: a persisting starvation must re-dwell AND wait out the cooldown', () => {
  const st = freshSelfHealState();
  evaluateSelfHeal(T0, 3, st, CFG);
  assert.equal(evaluateSelfHeal(T0 + 20 * MIN, 3, st, CFG).heal, true, 'heal #1');
  // Persisting starvation: the heal reset the onset, so the next tick re-latches
  // and the DWELL gate reports first — the rebuild gets time to work.
  const dwelling = evaluateSelfHeal(T0 + 21 * MIN, 3, st, CFG);
  assert.equal(dwelling.heal, false);
  assert.match(dwelling.reason, /dwell/);
  // Dwell re-met at +41m, but the 60m cooldown from heal #1 still holds.
  const held = evaluateSelfHeal(T0 + 45 * MIN, 3, st, CFG);
  assert.equal(held.heal, false);
  assert.match(held.reason, /cooldown/);
  // Past the cooldown, heal #2 fires.
  assert.equal(evaluateSelfHeal(T0 + 81 * MIN, 3, st, CFG).heal, true, 'heal #2 after cooldown');
});

test('cap: stands down at maxPerDay in a ROLLING 24h; capacity frees as heals age out (v1.90.0)', () => {
  const st = freshSelfHealState();
  let t = T0;
  for (let i = 0; i < CFG.maxPerDay; i++) {
    evaluateSelfHeal(t, 3, st, CFG);
    assert.equal(evaluateSelfHeal(t + 20 * MIN, 3, st, CFG).heal, true, `heal #${i + 1}`);
    t += 81 * MIN; // past cooldown each round
  }
  evaluateSelfHeal(t, 3, st, CFG);
  const capped = evaluateSelfHeal(t + 20 * MIN, 3, st, CFG);
  assert.equal(capped.heal, false);
  assert.match(capped.reason, /daily cap/);
  // v1.90.0 — the v1.76.0 UTC-day cap rolled at 17:00 MST, mid-evening: night
  // 9 spent 5 heals before 05:58 and BANKED the 6th into the next budget day.
  // The rolling window frees capacity exactly 24h after each heal instead. The
  // first heal was at T0+20min; 24h+21min after T0 it has aged out — and the
  // persisting starvation (onset latched, dwell long met, cooldown long past)
  // heals on the first eligible tick. A 12-hour starvation must not owe a
  // fresh dwell just because a budget boundary passed.
  const freed = T0 + 24 * 60 * MIN + 21 * MIN;
  const v = evaluateSelfHeal(freed, 3, st, CFG);
  assert.equal(v.heal, true, 'capacity freed as the oldest heal aged past 24h; all other gates long met');
  assert.equal(st.healTimesMs.length, CFG.maxPerDay, 'the window slid: oldest out, newest in');
  // and one minute BEFORE the oldest aged out, the cap still held
  const st2 = freshSelfHealState();
  let t2 = T0;
  for (let i = 0; i < CFG.maxPerDay; i++) {
    evaluateSelfHeal(t2, 3, st2, CFG);
    evaluateSelfHeal(t2 + 20 * MIN, 3, st2, CFG);
    t2 += 81 * MIN;
  }
  evaluateSelfHeal(t2, 3, st2, CFG);
  const still = evaluateSelfHeal(T0 + 24 * 60 * MIN + 19 * MIN, 3, st2, CFG);
  assert.equal(still.heal, false, 'one minute before the oldest heal ages out, the cap holds');
});

test('utcDayKey is deterministic and TZ-independent', () => {
  assert.equal(utcDayKey(Date.UTC(2026, 7, 10, 0, 0)), '2026-08-10');
  assert.equal(utcDayKey(Date.UTC(2026, 7, 10, 23, 59)), '2026-08-10');
  assert.equal(utcDayKey(Date.UTC(2026, 7, 11, 0, 0)), '2026-08-11');
});

/* ══════════════════════════════════════════════════════════════════════════
 * v1.93.0 — the rolling-24h budget must SURVIVE A RESTART.
 *
 * MOTIVATING INCIDENT (2026-08-20/21). `healTimesMs` lived only in process
 * memory, so the "6 per rolling 24 h" anti-thrash guarantee was really "6 per
 * process lifetime". Heals fired at 02:02/03:02/04:02/05:02 MST, the add-on
 * restarted at 09:53, and the next heal reported "heal 1/6 in the rolling 24h"
 * while 02:02 was still inside the window — 10 rebuilds in 22 h 14 m against a
 * nominal cap of 6. This add-on restarts several times a day, so an unpersisted
 * cap is no cap at all.
 * ═══════════════════════════════════════════════════════════════════════ */

test('self-heal budget — heals inside the window survive a restart; stale ones are pruned', () => {
  const dir = mkdtempSync(join(tmpdir(), 'selfheal-'));
  process.env.SELF_HEAL_STATE_PATH = join(dir, 'self-heal-budget.json');
  try {
    const st = freshSelfHealState();
    st.healTimesMs = [T0 - 25 * 60 * MIN * 60 / 60, T0 - 3 * 60 * MIN, T0 - 60 * MIN];
    // build explicitly: one 25h-old (stale), two recent
    st.healTimesMs = [T0 - 25 * 3600_000, T0 - 3 * 3600_000, T0 - 1 * 3600_000];
    st.lastHealMs = T0 - 1 * 3600_000;
    saveSelfHealState(st);

    const restored = loadSelfHealState(T0);
    assert.deepEqual(restored.healTimesMs, [T0 - 3 * 3600_000, T0 - 1 * 3600_000],
      'the 25h-old heal ages out; the two inside the window survive the restart');
    assert.equal(restored.lastHealMs, T0 - 1 * 3600_000, 'cooldown anchor survives too');
    assert.equal(restored.starvedSinceMs, null,
      'dwell is NOT inherited — it must be re-earned against live telemetry');
  } finally {
    delete process.env.SELF_HEAL_STATE_PATH;
  }
});

test('self-heal budget — a restart cannot grant a fresh six (the 08-20 defect)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'selfheal-'));
  process.env.SELF_HEAL_STATE_PATH = join(dir, 'self-heal-budget.json');
  try {
    const before = freshSelfHealState();
    before.healTimesMs = [1, 2, 3, 4, 5, 6].map((i) => T0 - i * 3600_000); // 6 heals, all inside 24h
    saveSelfHealState(before);

    // "restart": a brand-new state hydrated from disk, then asked to heal.
    const after = loadSelfHealState(T0);
    assert.equal(after.healTimesMs.length, 6, 'all six carried across the restart');
    // Re-earn the dwell against live telemetry (it is deliberately not inherited),
    // so the verdict below is decided by the CAP and not by the dwell gate.
    let v = evaluateSelfHeal(T0, 3, after, { ...CFG, cooldownMs: 0 });
    assert.equal(v.heal, false, 'dwell not yet satisfied immediately after restart');
    assert.match(v.reason, /dwell/i);
    v = evaluateSelfHeal(T0 + 25 * MIN, 3, after, { ...CFG, cooldownMs: 0 });
    assert.equal(v.heal, false, 'must stand down — pre-restart heals still count');
    assert.match(v.reason, /cap/i, 'blocked by the budget, not by the dwell');
  } finally {
    delete process.env.SELF_HEAL_STATE_PATH;
  }
});

test('self-heal budget — a missing or corrupt sidecar yields a clean empty budget (never throws)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'selfheal-'));
  process.env.SELF_HEAL_STATE_PATH = join(dir, 'nope.json');
  try {
    assert.deepEqual(loadSelfHealState(T0).healTimesMs, [], 'missing file');
    writeFileSync(join(dir, 'nope.json'), '{ not json');
    assert.deepEqual(loadSelfHealState(T0).healTimesMs, [], 'corrupt file');
    writeFileSync(join(dir, 'nope.json'), JSON.stringify({ healTimesMs: ['x', null, T0 - 60_000] }));
    assert.deepEqual(loadSelfHealState(T0).healTimesMs, [T0 - 60_000], 'non-numeric entries dropped');
  } finally {
    delete process.env.SELF_HEAL_STATE_PATH;
  }
});
