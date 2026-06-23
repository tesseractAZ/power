import { test } from 'node:test';
import assert from 'node:assert/strict';

import { backupPoolWithGraceHold, type BackupPoolHold } from '../src/ecoflow/project.js';

/* v0.56.0 — the backup-pool grace-hold. On a brief SHP2 cloud-reconnect blip the coherence gate
 * (v0.54.4) nulls the trio, flapping the gauge to "unknown" ~10-15×/day. The grace-hold substitutes
 * the LAST coherent trio for a bounded window so the gauge stays smooth; a SUSTAINED outage outlives
 * the window → falls through to null. A held value is always a previously-coherent trio, so it can
 * never reintroduce the transient zero v0.54.4 suppresses, and feeding it to the SoC alarm can't cascade. */

const REAL = { pct: 63, fullCapWh: 92160, remainWh: 58060 };           // ~63% coherent (58060/92160=63.0%)
const INCOHERENT = { pct: null, fullCapWh: null, remainWh: null };     // what coherentBackupPool returns on a blip
const WIN = 180_000;
const t0 = 1_000_000;

test('grace-hold — a live coherent reading passes through and (re)anchors the hold', () => {
  const r = backupPoolWithGraceHold(REAL, null, t0, WIN);
  assert.deepEqual(r.out, REAL);
  assert.equal(r.source, 'live');
  assert.deepEqual(r.hold, { ...REAL, atMs: t0 });
});

test('grace-hold — a brief blip serves the held trio and does NOT refresh the anchor', () => {
  const held: BackupPoolHold = { ...REAL, atMs: t0 };
  const r = backupPoolWithGraceHold(INCOHERENT, held, t0 + 60_000, WIN);
  assert.deepEqual(r.out, REAL);
  assert.equal(r.source, 'held');
  assert.equal(r.hold!.atMs, t0, 'anchor stays at the last COHERENT reading, so the window keeps closing');
});

test('grace-hold — a sustained incoherence falls to unknown past the window (boundary exact)', () => {
  const held: BackupPoolHold = { ...REAL, atMs: t0 };
  // exactly at the window edge → still held
  assert.equal(backupPoolWithGraceHold(INCOHERENT, held, t0 + WIN, WIN).source, 'held');
  // one ms past → unknown, hold dropped
  const past = backupPoolWithGraceHold(INCOHERENT, held, t0 + WIN + 1, WIN);
  assert.deepEqual(past.out, INCOHERENT);
  assert.equal(past.source, 'none');
  assert.equal(past.hold, null);
});

test('grace-hold — re-coherence inside the window re-anchors from the new reading', () => {
  const held: BackupPoolHold = { ...REAL, atMs: t0 };
  const blip = backupPoolWithGraceHold(INCOHERENT, held, t0 + 60_000, WIN);     // held
  const back = backupPoolWithGraceHold(REAL, blip.hold, t0 + 120_000, WIN);     // coherent again
  assert.equal(back.source, 'live');
  assert.equal(back.hold!.atMs, t0 + 120_000, 'a later incoherence is now measured from the new anchor');
});

test('grace-hold — windowMs=0 disables the hold (behaves like pre-v0.56.0)', () => {
  const held: BackupPoolHold = { ...REAL, atMs: t0 };
  const r = backupPoolWithGraceHold(INCOHERENT, held, t0 + 1, 0);
  assert.equal(r.source, 'none');
  assert.deepEqual(r.out, INCOHERENT);
});

test('grace-hold — a real change is published at most one tick late, bounded well under 1%', () => {
  // 63% coherent, then 2 incoherent ticks (held at 63%), then a real 62.8% — the alarm/gauge see the
  // real value one tick late. The masked delta (0.2%) is far below every SoC-alarm guard.
  let hold: BackupPoolHold | null = null;
  ({ hold } = backupPoolWithGraceHold(REAL, hold, t0, WIN));                     // live 63
  let r = backupPoolWithGraceHold(INCOHERENT, hold, t0 + 60_000, WIN); hold = r.hold;  // held 63
  assert.equal(r.out.pct, 63);
  r = backupPoolWithGraceHold(INCOHERENT, hold, t0 + 120_000, WIN); hold = r.hold;     // held 63
  assert.equal(r.out.pct, 63);
  const real = { pct: 62.8, fullCapWh: 92160, remainWh: 57876 };
  r = backupPoolWithGraceHold(real, hold, t0 + 180_000, WIN);                          // coherent → live
  assert.equal(r.source, 'live');
  assert.equal(r.out.pct, 62.8);
  assert.ok(Math.abs(63 - 62.8) < 1, 'masked SoC delta over the window is well under 1%');
});
