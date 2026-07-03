import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  backupPoolWithGraceHold,
  BACKUP_POOL_MAX_SLEW_PCT,
  type BackupPoolHold,
} from '../src/ecoflow/project.js';

/* v0.81.0 — coherent-but-implausible SoC slew guard at the SHARED backup-pool seam.
 *
 * A stale SHP2 cloud-reconnect can return an internally-CONSISTENT trio whose pct
 * plummets impossibly in one poll (live 2026-07-03: 44→17% during a DPU resync).
 * The v0.54.4 coherence gate can't catch it (all three fields present + consistent),
 * so it used to publish as 'live' → recorded to history AND fed forecast-runtime,
 * which fired a false "1h 21m to reserve" push — while batterySocAlarm's own guard
 * correctly rejected it. Moving the guard here means every consumer (recorder /
 * gauge / forecast) sees the same held value the alarm already used.
 *
 * Guarded ONLY for a DROP from a FRESH (< 10 min) HEALTHY (≥ 30%) held baseline;
 * the hold is returned UNCHANGED so a sustained bad value keeps being rejected and
 * it self-heals the instant a real read returns. */

const FULL = 92160;
const WIN = 180_000;
const t0 = 1_000_000;
const MAX_AGE = 10 * 60 * 1000;

// A coherent trio at a given pct (remainWh consistent with pct·full).
const coherent = (pct: number) => ({ pct, fullCapWh: FULL, remainWh: Math.round((pct / 100) * FULL) });

test('slew guard — an implausible one-poll DROP from a fresh healthy baseline is rejected (held served, anchor unchanged)', () => {
  // Establish a fresh, healthy 44% baseline.
  const anchor = backupPoolWithGraceHold(coherent(44), null, t0, WIN);
  assert.equal(anchor.source, 'live');
  const held = anchor.hold as BackupPoolHold;

  // 44 → 17 in the next poll: a 27-pt drop, above the 25-pt guard → REJECTED.
  const r = backupPoolWithGraceHold(coherent(17), held, t0 + 60_000, WIN);
  assert.equal(r.source, 'held', 'implausible coherent drop must serve the held value');
  assert.equal(r.out.pct, 44, 'the recorder/forecast see the last good pct, not the artifact');
  assert.equal(r.hold!.atMs, t0, 'anchor is NOT advanced — a sustained artifact keeps being rejected');
});

test('slew guard — the drop threshold is exactly BACKUP_POOL_MAX_SLEW_PCT (boundary)', () => {
  const held = (backupPoolWithGraceHold(coherent(60), null, t0, WIN).hold) as BackupPoolHold;
  // Exactly at the threshold (drop == MAX) is NOT rejected (guard uses strict >).
  const atEdge = backupPoolWithGraceHold(coherent(60 - BACKUP_POOL_MAX_SLEW_PCT), held, t0 + 1000, WIN);
  assert.equal(atEdge.source, 'live', 'a drop exactly at the threshold passes through');
  // One point past the threshold IS rejected.
  const past = backupPoolWithGraceHold(coherent(60 - BACKUP_POOL_MAX_SLEW_PCT - 1), held, t0 + 1000, WIN);
  assert.equal(past.source, 'held', 'a drop past the threshold is rejected');
});

test('slew guard — a gradual real discharge is NEVER masked', () => {
  // Many small steps well under the guard: every one publishes live, so a real
  // slow drawdown is honored end to end.
  let hold: BackupPoolHold | null = null;
  let ts = t0;
  for (let pct = 80; pct >= 20; pct -= 3) {           // 3-pt steps ≪ 25
    const r = backupPoolWithGraceHold(coherent(pct), hold, ts, WIN);
    assert.equal(r.source, 'live', `pct=${pct} must publish live`);
    assert.equal(r.out.pct, pct);
    hold = r.hold;
    ts += 60_000;
  }
});

test('slew guard — a deep-discharge read from an ALREADY-LOW baseline is honored (guard inactive below healthy)', () => {
  // Baseline 20% (< 30% healthy floor): even a large further drop is a real event
  // on an already-drained pool, so the guard must NOT fire.
  const held = (backupPoolWithGraceHold(coherent(20), null, t0, WIN).hold) as BackupPoolHold;
  const r = backupPoolWithGraceHold(coherent(3), held, t0 + 60_000, WIN); // 17-pt drop but baseline unhealthy
  assert.equal(r.source, 'live', 'below the healthy baseline the guard is inactive — real low honored');
  assert.equal(r.out.pct, 3);
});

test('slew guard — a low-SoC reconnect after a STALE baseline is honored, never masked (safety-critical)', () => {
  // The SHP2 was genuinely offline > max-age; when it returns at a real low pct the
  // held baseline is stale, so the guard is inactive and the true low is published.
  const held = (backupPoolWithGraceHold(coherent(50), null, t0, WIN).hold) as BackupPoolHold;
  const r = backupPoolWithGraceHold(coherent(12), held, t0 + MAX_AGE + 1, WIN); // baseline aged out
  assert.equal(r.source, 'live', 'a stale baseline must not suppress a genuine low reconnect');
  assert.equal(r.out.pct, 12, 'the floor/runway alarms MUST see a real low pool');
});

test('slew guard — a small RISE passes through (only implausibly-large jumps are rejected)', () => {
  const held = (backupPoolWithGraceHold(coherent(30), null, t0, WIN).hold) as BackupPoolHold;
  const r = backupPoolWithGraceHold(coherent(48), held, t0 + 60_000, WIN); // +18, under the 25 slew
  assert.equal(r.source, 'live', 'a plausible rise (charging) passes through');
  assert.equal(r.out.pct, 48);
});

test('slew guard — an implausible RISE from a fresh baseline is rejected REGARDLESS of baseline health (anti-poisoning)', () => {
  // v0.81.0 adversarial finding: a stale-HIGH SHP2 reconnect replay from a genuinely
  // LOW pool would otherwise become the fresh "healthy" baseline and then arm the
  // drop guard to MASK the real low from the runway/floor CRITICAL. The upward guard
  // has NO healthy-baseline gate, so it fires even from a low baseline.
  const held = (backupPoolWithGraceHold(coherent(8), null, t0, WIN).hold) as BackupPoolHold;
  const glitch = backupPoolWithGraceHold(coherent(40), held, t0 + 60_000, WIN); // +32 from a LOW 8%
  assert.equal(glitch.source, 'held', 'a >25pt rise from a fresh baseline is a non-physical glitch → rejected');
  assert.equal(glitch.out.pct, 8, 'the conservative LOWER value is kept — a rise can only ever over-alarm, never mask a low');
  assert.equal(glitch.hold!.atMs, t0, 'the high glitch never becomes the baseline (anchor unmoved)');
});

test('slew guard — SAFETY: the upward guard stops a stale-HIGH glitch from masking the real low that follows', () => {
  // Full attack timeline: genuinely low pool (8%) → stale-HIGH reconnect glitch (40%)
  // → real lows (6/4/2%). The runway/floor reads backupRemainWh through this seam, so
  // the real lows MUST reach it (belowReserveFloor must see 2%, not a held 40%).
  let hold: BackupPoolHold | null = backupPoolWithGraceHold(coherent(8), null, t0, WIN).hold; // baseline 8%
  let ts = t0 + 60_000;
  const glitch = backupPoolWithGraceHold(coherent(40), hold, ts, WIN);   // rejected → held 8%
  assert.equal(glitch.out.pct, 8);
  hold = glitch.hold;
  for (const real of [6, 4, 2]) {
    ts += 60_000;
    const r = backupPoolWithGraceHold(coherent(real), hold, ts, WIN);
    // Each real low is a small drop from the (un-poisoned) evolving baseline → published.
    assert.equal(r.source, 'live', `real low ${real}% must reach the runway/floor, not be masked`);
    assert.equal(r.out.pct, real);
    hold = r.hold;
  }
});

test('slew guard — it self-heals: after rejecting an artifact, the next real read re-anchors', () => {
  const held = (backupPoolWithGraceHold(coherent(44), null, t0, WIN).hold) as BackupPoolHold;
  const rejected = backupPoolWithGraceHold(coherent(17), held, t0 + 60_000, WIN); // artifact → held
  assert.equal(rejected.source, 'held');
  // A plausible real value one tick later publishes live and re-anchors.
  const back = backupPoolWithGraceHold(coherent(43), rejected.hold, t0 + 120_000, WIN);
  assert.equal(back.source, 'live');
  assert.equal(back.out.pct, 43);
  assert.equal(back.hold!.atMs, t0 + 120_000, 'the anchor advances only on a real read');
});
