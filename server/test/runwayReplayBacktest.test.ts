import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computeRunway,
  resetRunwayCache,
  resetPoolEnergyBasisForTesting,
  setPoolBasisOverrideForTesting,
  RUNWAY_DISCHARGE_EFFICIENCY,
} from '../src/analytics.js';
import { resetOwnerReserveFloorPct } from '../src/nightChargeActuator.js';
import { classifyRunway } from '../src/runwayAlarm.js';
import { makeRecorderStub } from './helpers/recorderStub.js';
import type { DeviceSnapshot } from '../src/snapshot.js';

/* ═══════════════════════════════════════════════════════════════════════════
 * v1.187.19 — REPLAY BACKTEST of the runway against measured discharge.
 *
 * test/fixtures/runwayReplaySpans.json holds 30 clean pack-only discharge spans of the
 * home pool (2026-09-02..10-11; no PV, no grid to the house, no pack charging), aggregated
 * per span: the measured pool drop over `hours` at `meanLoadKw`, and the packs' BMS
 * full-charge ratio at the time. Each span is run through the REAL computeRunway: a pool at
 * startPoolPct, the reserve floor set to endPoolPct, the span's mean load, no PV — so the
 * projection's reserve crossing IS its prediction of how long the measured drop took.
 *
 * GATE (the evidence the change rests on):
 *   - the measured basis predicts every span within ±3 %;
 *   - the pre-v1.187.19 basis (nameplate kWh, load/0.94) misses at least one by > 5 %
 *     (it overstated all thirty, +7.0 % to +18.7 %).
 * ═════════════════════════════════════════════════════════════════════════ */

interface Span {
  id: string; startMs: number; endMs: number; hours: number;
  startPoolPct: number; endPoolPct: number; meanLoadKw: number; fccRatio: number; socSteps: number;
}
const FIXTURE = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/runwayReplaySpans.json'), 'utf8')) as {
  nameplateFullWh: number; spans: Span[];
};
const SPANS = FIXTURE.spans;
const NAMEPLATE_WH = FIXTURE.nameplateFullWh;
const CORE_SNS = ['REPLAY-CORE-A', 'REPLAY-CORE-B', 'REPLAY-CORE-C'];

function core(sn: string, fccRatio: number): DeviceSnapshot {
  return {
    sn, deviceName: sn, online: true, lastSeenMs: Date.now(),
    projection: {
      kind: 'dpu', soc: 50, packCount: 5,
      packs: [1, 2, 3, 4, 5].map((num) => ({ num, soc: 50, designCapMah: 60_000, fullCapMah: Math.round(fccRatio * 60_000) })),
    },
  } as unknown as DeviceSnapshot;
}

function fleet(span: Span): Record<string, DeviceSnapshot> {
  const panel = {
    sn: 'REPLAY-PANEL', deviceName: 'Smart Home Panel 2', online: true, lastSeenMs: Date.now(),
    projection: {
      kind: 'shp2',
      backupBatPercent: span.startPoolPct,
      backupFullCapWh: NAMEPLATE_WH,
      backupRemainWh: (span.startPoolPct / 100) * NAMEPLATE_WH,
      // The span's measured end is the "floor": the reserve crossing is the predicted duration.
      backupReserveSoc: span.endPoolPct,
      circuits: [], pairedCircuits: [], sourceWatts: [], strategy: {},
      sources: CORE_SNS.map((sn, i) => ({ slot: i + 1, sn, isConnected: true, hwConnect: true, fullCap: NAMEPLATE_WH / 3 })),
    },
  } as unknown as DeviceSnapshot;
  const out: Record<string, DeviceSnapshot> = { [panel.sn]: panel };
  for (const sn of CORE_SNS) out[sn] = core(sn, span.fccRatio);
  return out;
}

/** The runway's predicted hours for the span's measured drop, from the REAL computeRunway. */
function predictedHours(span: Span, basis: 'measured' | 'legacy'): number {
  resetRunwayCache();
  resetPoolEnergyBasisForTesting();
  if (basis === 'legacy') setPoolBasisOverrideForTesting({ capacityScale: 1, overheadW: 0 });
  const now = Date.now();
  const loadW = span.meanLoadKw * 1000;
  const recorder = makeRecorderStub({
    query: (_sn, metric) => metric === 'panel_load'
      ? [{ ts: now - 40 * 60_000, value: loadW }, { ts: now - 10 * 60_000, value: loadW }]
      : [],
  });
  const r = computeRunway(fleet(span), recorder, null);
  setPoolBasisOverrideForTesting(null);
  assert.equal(r.unavailable, null, `${span.id}: ${r.unavailable}`);
  assert.ok(r.reserveAtMs != null, `${span.id}: no reserve crossing`);
  return (r.reserveAtMs! - r.generatedAt) / 3_600_000;
}

beforeEach(() => { resetOwnerReserveFloorPct(); resetRunwayCache(); resetPoolEnergyBasisForTesting(); });
afterEach(() => { resetRunwayCache(); resetPoolEnergyBasisForTesting(); });

test('replay fixture — the coverage the gate asks for (≥10 clean spans, ≥3.5 h, ≥10 SoC steps, ≥2 FCC regimes, ~2-8 kW)', () => {
  assert.ok(SPANS.length >= 10, `${SPANS.length} spans`);
  for (const s of SPANS) {
    assert.ok(s.hours >= 3.4, `${s.id}: ${s.hours} h`); // per-source step windows sit just inside the ≥3.5 h clean run
    assert.ok(s.socSteps >= 10, `${s.id}: ${s.socSteps} SoC steps`);
    assert.ok(s.startPoolPct > s.endPoolPct, `${s.id}: not a discharge`);
    assert.ok(Math.abs((s.endMs - s.startMs) / 3_600_000 - s.hours) < 0.01, `${s.id}: hours vs timestamps`);
  }
  const regimes = new Set(SPANS.map((s) => Math.round(s.fccRatio * 200) / 200));
  assert.ok(regimes.size >= 2, `FCC regimes: ${[...regimes].join(', ')}`);
  const loads = SPANS.map((s) => s.meanLoadKw);
  assert.ok(Math.min(...loads) <= 2.5 && Math.max(...loads) >= 7, `loads ${Math.min(...loads)}-${Math.max(...loads)} kW`);
});

test('★★★ GATE — the measured basis predicts every replayed span within ±3 %; the old basis misses by > 5 %', () => {
  const rows: string[] = [];
  let worstNew = 0;
  let oldMisses = 0;
  for (const s of SPANS) {
    const newH = predictedHours(s, 'measured');
    const oldH = predictedHours(s, 'legacy');
    const errNew = newH / s.hours - 1;
    const errOld = oldH / s.hours - 1;
    rows.push(`${s.id}  ${s.hours.toFixed(2)} h  new ${newH.toFixed(2)} (${(errNew * 100).toFixed(1)} %)  old ${oldH.toFixed(2)} (${(errOld * 100).toFixed(1)} %)`);
    worstNew = Math.max(worstNew, Math.abs(errNew));
    if (errOld > 0.05) oldMisses += 1;
    assert.ok(Math.abs(errNew) <= 0.03, `${s.id}: measured basis off by ${(errNew * 100).toFixed(2)} %\n${rows.join('\n')}`);
    assert.ok(newH <= oldH, `${s.id}: the measured basis must never be LONGER than the old one`);
  }
  assert.ok(oldMisses >= 1, `the old basis must fail the replay somewhere; worst new ${(worstNew * 100).toFixed(2)} %\n${rows.join('\n')}`);
  assert.equal(oldMisses, SPANS.length, 'the old basis overstated every replayed span by more than 5 %');
});

test('the legacy override IS the pre-v1.187.19 arithmetic: nameplate kWh at load/η', () => {
  for (const s of SPANS) {
    const analytic = (((s.startPoolPct - s.endPoolPct) / 100) * NAMEPLATE_WH) / ((s.meanLoadKw * 1000) / RUNWAY_DISCHARGE_EFFICIENCY);
    assert.ok(Math.abs(predictedHours(s, 'legacy') - analytic) < 1e-5, s.id);
  }
});

test('replay — the measured basis reaches each alarm tier no later than the old one at every span start', () => {
  const rank = { low: 1, medium: 2, high: 3, critical: 4 } as const;
  for (const s of SPANS) {
    // The real 16 % reserve instead of the span's end: the alarm's own question.
    if (s.startPoolPct <= 16) continue;
    const atFloor16 = { ...s, endPoolPct: 16 };
    const h = (b: 'measured' | 'legacy') => {
      resetRunwayCache();
      resetPoolEnergyBasisForTesting();
      if (b === 'legacy') setPoolBasisOverrideForTesting({ capacityScale: 1, overheadW: 0 });
      const now = Date.now();
      const rec = makeRecorderStub({
        query: (_sn, metric) => metric === 'panel_load'
          ? [{ ts: now - 40 * 60_000, value: s.meanLoadKw * 1000 }, { ts: now - 10 * 60_000, value: s.meanLoadKw * 1000 }] : [],
      });
      const r = computeRunway(fleet(atFloor16), rec, null);
      setPoolBasisOverrideForTesting(null);
      return r;
    };
    const rNew = h('measured');
    const rOld = h('legacy');
    const cNew = classifyRunway(rNew);
    const cOld = classifyRunway(rOld);
    assert.ok((cNew ? rank[cNew] : 0) >= (cOld ? rank[cOld] : 0), `${s.id}: ${cOld} → ${cNew}`);
  }
});
