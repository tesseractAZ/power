/**
 * v0.42.0 — Battery page accuracy audit: LFP OCV cell-count regression.
 *
 * The DPU pack is 32S1P (~104 V nominal; 32 series cells whose mV sum to
 * packVoltageMv). socFromOcv() previously divided a pack-total voltage by a
 * hardcoded 16, yielding ~6.5 V/cell — outside the LFP table — so a real
 * resting pack clamped to 100 % (or returned null). These tests pin the
 * 32-cell scaling: a realistic resting pack-total voltage must map to a sane
 * mid-range SoC, NOT clamp-to-100 and NOT null.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { socFromOcv, ocvFromSoc } from '../src/physics/lfpOcv.js';

const CELLS = 32;

/* (a) Realistic resting 32S pack voltage → sane mid-range SoC (not null, not 100). */
test('socFromOcv — realistic resting 32S pack voltage yields a sane mid-range SoC', () => {
  // 3.30 V/cell is a mid-SoC table point; a real ~104 V pack scales by 32.
  const packVolts = 3.30 * CELLS; // = 105.6 V
  const soc = socFromOcv(packVolts); // pack-total path (perCell = false → divides by 32)
  assert.ok(soc != null, 'resting pack voltage should not produce a null SoC');
  assert.ok(soc > 0 && soc < 100, `SoC should be strictly in (0,100), got ${soc}`);
  // With the OLD /16 scaling this was ~6.6 V/cell → clamped to 100; prove it isn't.
  assert.notEqual(soc, 100, 'SoC must not clamp to 100 (that was the 16-cell bug)');
  // 3.30 V/cell sits around the 40-45 % SoC region of the table.
  assert.ok(soc >= 30 && soc <= 60, `expected ~40-45% region, got ${soc.toFixed(1)}`);
});

/* (b) Per-cell call at a known table point returns the expected SoC. */
test('socFromOcv — per-cell call at a known table point returns expected SoC', () => {
  // Table: [20, 3.25] and [25, 3.27]. 3.25 V/cell → SoC ~20%.
  const soc = socFromOcv(3.25, true);
  assert.ok(soc != null, 'per-cell table point should not be null');
  assert.ok(Math.abs((soc ?? 0) - 20) <= 3, `expected ~20%, got ${soc?.toFixed(1)}`);

  // 3.34 V/cell → SoC ~80%.
  const soc80 = socFromOcv(3.34, true);
  assert.ok(soc80 != null && Math.abs(soc80 - 80) <= 3, `expected ~80%, got ${soc80?.toFixed(1)}`);
});

/* (c) Round-trip ocvFromSoc → socFromOcv is approximately stable (pack-total path). */
test('socFromOcv — round-trips through pack-total voltage with 32-cell scaling', () => {
  for (const soc of [15, 30, 50, 70, 85]) {
    // Build a pack-TOTAL voltage (perCell=false multiplies by 32), then read it
    // back through the pack-total path (divides by 32). Exercises the bug site.
    const packVolts = ocvFromSoc(soc, false);
    // Sanity: the synthesized pack voltage is in the real ~96-115 V band.
    assert.ok(packVolts > 95 && packVolts < 116, `pack volts ${packVolts.toFixed(1)} out of band for SoC ${soc}`);
    const back = socFromOcv(packVolts);
    assert.ok(back != null, `SoC ${soc}% should round-trip (not null)`);
    assert.ok(Math.abs((back ?? 0) - soc) <= 5, `SoC ${soc}% → ${packVolts.toFixed(1)}V → ${back?.toFixed(1)}%`);
  }
});
