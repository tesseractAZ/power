import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveWholeUnitBatAmp } from '../src/ecoflow/project.js';

// v0.33.0 — the whole-unit DPU battery current is derived from per-pack power
// (Σ inputWatts − Σ outputWatts) ÷ batVol, because the raw register under-reads
// by ~4–7×. Sign: charging → positive, discharging → negative.

test('discharging — derives the real negative current from summed pack output (live Core-1 shape)', () => {
  // 5 packs delivering ~2248W total at a 104.7V stack — register reported only -3.1A.
  const packs = [
    { inputWatts: 0, outputWatts: 450 },
    { inputWatts: 0, outputWatts: 450 },
    { inputWatts: 0, outputWatts: 449 },
    { inputWatts: 0, outputWatts: 450 },
    { inputWatts: 0, outputWatts: 449 },
  ];
  const a = deriveWholeUnitBatAmp(packs, 104.7, -3.1);
  assert.equal(a, Math.round((-2248 / 104.7) * 100) / 100); // ≈ -21.47A
  assert.ok(a! < -20 && a! > -22, 'should be ~-21A, the physically-correct draw — not the register -3.1A');
});

test('charging — positive current', () => {
  const packs = [{ inputWatts: 500, outputWatts: 0 }, { inputWatts: 500, outputWatts: 0 }];
  const a = deriveWholeUnitBatAmp(packs, 105, -3);
  assert.equal(a, Math.round((1000 / 105) * 100) / 100); // ≈ +9.52A
  assert.ok(a! > 9 && a! < 10);
});

test('mixed nulls — uses whatever pack data is present', () => {
  const packs = [{ inputWatts: null, outputWatts: 1000 }, { inputWatts: null, outputWatts: null }];
  assert.equal(deriveWholeUnitBatAmp(packs, 100, -1), -10);
});

test('no pack power data — falls back to the raw register', () => {
  const packs = [{ inputWatts: null, outputWatts: null }, { inputWatts: null, outputWatts: null }];
  assert.equal(deriveWholeUnitBatAmp(packs, 104, -3.1), -3.1);
});

test('missing / implausible batVol — falls back to the register (no divide-by-zero)', () => {
  const packs = [{ inputWatts: 0, outputWatts: 2000 }];
  assert.equal(deriveWholeUnitBatAmp(packs, null, -3.1), -3.1);
  assert.equal(deriveWholeUnitBatAmp(packs, 0, -3.1), -3.1);
});

test('idle — zero net pack power yields 0A (not the register)', () => {
  const packs = [{ inputWatts: 0, outputWatts: 0 }];
  assert.equal(deriveWholeUnitBatAmp(packs, 104, -3.1), 0);
});
