import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setBackupReserveSoc } from '../src/ecoflow/commands.js';

/* ── v1.50.0 — the bounded night-charge reserve write (validation only; the
 *    in-range path would hit the live EcoFlow API and is exercised by the
 *    actuator's supervised night, not by unit tests). ── */

test('setBackupReserveSoc refuses out-of-range and non-integer targets without any API call', async () => {
  // v1.161.0 — the envelope is [10, 90]; 51 is now a LEGAL target, 91 is not.
  for (const bad of [9, 91, 37.8, Number.NaN, -10]) {
    const r = await setBackupReserveSoc({ sn: 'TESTSN', targetPct: bad, source: {} });
    assert.equal(r.outcome, 'failure');
    assert.equal(r.code, 'reserve-out-of-range');
  }
});
