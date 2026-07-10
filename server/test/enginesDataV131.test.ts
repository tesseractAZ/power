import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { socFromOcv, ocvFromSoc } from '../src/physics/lfpOcv.js';
import { rotateTelemetryIfOversized, ROTATE_AT_BYTES } from '../src/alertTelemetry.js';

/* ===================================================================
 * v1.3.1 — engines & data findings from the 21-dimension audit.
 * =================================================================== */

/* ── rank 51: socFromOcv collapsed the LFP plateau to its LOW end ── */

test('a cell resting exactly on an OCV plateau reports the MIDPOINT, not the low end', () => {
  // The table holds 3.30 V at BOTH 40 % and 45 %. The old loop matched the RISING bracket
  // [35, 3.29] → [40, 3.30] first (endpoints differ, frac = 1) and returned 40 — silently
  // biasing socDriftPct low by up to 5 points. LFP's OCV curve genuinely cannot resolve SoC
  // on the plateau; the honest answer is the centre of the ambiguity band.
  assert.equal(socFromOcv(3.30, true), 42.5);
  assert.equal(socFromOcv(3.31, true), 52.5);
  assert.equal(socFromOcv(3.32, true), 62.5);
  assert.equal(socFromOcv(3.33, true), 72.5);
});

test('a cell strictly BETWEEN table points still interpolates linearly', () => {
  // 3.295 V sits halfway across [35, 3.29] → [40, 3.30]; no plateau involved.
  assert.ok(Math.abs(socFromOcv(3.295, true)! - 37.5) < 1e-9);
  // A non-plateau exact point returns that point.
  assert.equal(socFromOcv(3.29, true), 35);
  assert.equal(socFromOcv(3.35, true), 85);
});

test('the table range clamps are untouched', () => {
  assert.equal(socFromOcv(2.0, true), 0);
  assert.equal(socFromOcv(4.0, true), 100);
  assert.equal(socFromOcv(Number.NaN, true), null);
});

test('socFromOcv is monotonic non-decreasing across the whole table', () => {
  let prev = -Infinity;
  for (let mv = 2500; mv <= 3550; mv++) {
    const soc = socFromOcv(mv / 1000, true);
    assert.ok(soc != null, `null at ${mv} mV`);
    assert.ok(soc! >= prev, `SoC must never decrease as OCV rises (${mv} mV → ${soc} after ${prev})`);
    prev = soc!;
  }
});

test('the plateau midpoint stays INSIDE the band the inverse curve maps to', () => {
  // ocvFromSoc(40) === ocvFromSoc(45) === 3.30 — so any answer in [40, 45] is consistent with
  // the physics. The midpoint is the one that minimises worst-case error.
  assert.equal(ocvFromSoc(40, true), 3.30);
  assert.equal(ocvFromSoc(45, true), 3.30);
  const mid = socFromOcv(3.30, true)!;
  assert.ok(mid >= 40 && mid <= 45);
});

/* ── rank 49: alert-telemetry.jsonl grew without bound ── */

test('the telemetry log rotates once it passes twice the replay budget', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eco-telem-'));
  const p = join(dir, 'alert-telemetry.jsonl');

  const line = JSON.stringify({ familyKey: 'pack-hot', alertId: 'pack-hot-A', event: 'rise', ts: 1 }) + '\n';
  const repeats = Math.ceil((ROTATE_AT_BYTES + 1024) / line.length);
  writeFileSync(p, line.repeat(repeats));
  assert.ok(statSync(p).size > ROTATE_AT_BYTES);

  assert.equal(rotateTelemetryIfOversized(p), true);
  const after = statSync(p).size;
  assert.ok(after <= ROTATE_AT_BYTES / 2, `expected <= replay budget, got ${after}`);

  // Every surviving line must still parse — the leading PARTIAL line is dropped.
  const lines = readFileSync(p, 'utf8').split('\n').filter((l) => l.length > 0);
  assert.ok(lines.length > 0);
  for (const l of lines) assert.doesNotThrow(() => JSON.parse(l));
});

test('a log under the threshold is left completely alone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eco-telem-'));
  const p = join(dir, 'alert-telemetry.jsonl');
  const body = JSON.stringify({ familyKey: 'f', alertId: 'a', event: 'rise', ts: 1 }) + '\n';
  writeFileSync(p, body);
  assert.equal(rotateTelemetryIfOversized(p), false);
  assert.equal(readFileSync(p, 'utf8'), body, 'a small log is never rewritten');
});

test('rotating a missing log is a safe no-op', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eco-telem-'));
  assert.equal(rotateTelemetryIfOversized(join(dir, 'nope.jsonl')), false);
});
