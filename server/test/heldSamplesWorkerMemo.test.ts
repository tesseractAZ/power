/**
 * v1.188.1 (review) — the analytics worker's closed-day memos do not outlive a held-sample move.
 *
 * Two worker caches assume `samples` only grows: the per-day energy memo (windowedEnergyWh, the
 * 7-day self-consumption and carbon KPIs) keeps a closed day's integral for the life of the
 * process, and the 60-day equipment-health series (eqQueryMulti, the inverter-standby trend)
 * re-reads only its tail. The worker's first warm pass runs seconds after a boot and the first
 * held-sample scan a minute later, so on the upgrade boot the incident's closed day was memoised
 * with its held flows and served until the next restart. The scan now advances a samples
 * generation in the same transaction as each move (heldSamples.ts), and the report chokepoint
 * (reports.ts buildReport → noteSamplesGeneration) resets the memos and every result cache when
 * it has moved. Fake serials; the database is a real recorder's, read through the worker's own
 * kind of connection.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import { makeRecorderStub } from './helpers/recorderStub.js';

const tmp = mkdtempSync(join(tmpdir(), 'ef-held-memo-'));
process.env.DB_PATH = join(tmp, 'ecoflow.db');
const DB_PATH = join(tmp, 'ecoflow.db');

const { createRecorder } = await import('../src/recorder.js');
const { createReadRecorder } = await import('../src/readRecorder.js');
const { windowedEnergyWh, eqQueryMulti, resetDailyEnergyCache, resetEquipmentHealthCaches } = await import('../src/analytics.js');
const { startOfLocalDayMs } = await import('../src/aggregator.js');
const reports = await import('../src/reports.js');

const MIN = 60_000;
const H = 60 * MIN;
const SN = 'COREXXX00XXX0009';
const METRICS = ['soc', 'ac_in', 'ac_out', 'pv_total', 'pack1_in', 'pack1_out', 'bat_vol', 'bat_amp', 'pack1_soc', 'pack1_temp'];

function makeStore() {
  const ee = new EventEmitter() as any;
  ee.snap = { generatedAt: 0, devices: {} };
  ee.get = () => ee.snap;
  return ee;
}

test('★★★ a closed day memoised before the scan is re-integrated after it moved the held rows', () => {
  const real = Date.now();
  const todayStart = startOfLocalDayMs(new Date(real));
  // Far enough into today that every held row (to midnight) is past the 15-min move age.
  const now = Math.max(real, todayStart + 2 * H);
  const yStart = startOfLocalDayMs(new Date(todayStart - 12 * H));
  const rec = createRecorder(makeStore(), () => {});
  const rr = createReadRecorder(DB_PATH);
  reports.resetReportBasisForTesting();
  resetDailyEnergyCache();
  resetEquipmentHealthCaches();
  try {
    // Yesterday: 2 h live (ac_in near 0 W), then about 20 h of one reading restated every 5 min
    // with ac_in held at 1 kW and ac_out at 400 W; today live again.
    const db = new DatabaseSync(DB_PATH);
    try {
      const ins = db.prepare('INSERT INTO samples (ts, sn, metric, value) VALUES (?, ?, ?, ?)');
      const lastFresh = yStart + 2 * H;
      const heldValue = (m: string, i: number) => (m === 'ac_in' ? 1000 : m === 'ac_out' ? 400 : 100 + i * 10 + i / 100);
      db.exec('BEGIN');
      let k = 0;
      for (let ts = yStart; ts < lastFresh; ts += MIN, k++) {
        METRICS.forEach((m, i) => ins.run(ts, SN, m, m === 'ac_in' ? k % 2 : m === 'ac_out' ? 50 + (k % 3) : 100 + i * 10 + (k % 17) + i / 100));
      }
      METRICS.forEach((m, i) => ins.run(lastFresh, SN, m, heldValue(m, i)));
      for (let ts = lastFresh + 5 * MIN; ts < todayStart; ts += 5 * MIN) METRICS.forEach((m, i) => ins.run(ts + i * 1_000, SN, m, heldValue(m, i)));
      for (let ts = todayStart + 5 * MIN, j = 0; ts < now - 20 * MIN; ts += MIN, j++) {
        METRICS.forEach((m, i) => ins.run(ts, SN, m, 100 + i * 10 + (j % 13) + i / 100));
      }
      db.exec('COMMIT');
    } finally { db.close(); }

    const acIn = () => windowedEnergyWh(rr, SN, ['ac_in'], yStart, now, 60, todayStart).get('ac_in')! / 1000;
    const heldBuckets = () => (eqQueryMulti(rr, SN, ['ac_out', 'pv_total'], now - 60 * 86_400_000, now).get('ac_out') ?? [])
      .filter((p) => p.ts > yStart + 3 * H && p.ts < todayStart).length;
    // The worker's first warm pass, before the scan.
    assert.equal(reports.noteSamplesGeneration(rr.samplesGeneration!()), false, 'the first request only records the generation');
    const before = acIn();
    assert.ok(before > 18, `precondition: the held 1 kW was integrated (${before.toFixed(1)} kWh)`);
    assert.ok(heldBuckets() > 100, 'precondition: the health series holds the held buckets');

    const moved = rec.scanHeldSamples!(now).rowsMoved;
    assert.ok(moved > 2_000, `the scan moved the held rows (${moved})`);
    assert.ok(Math.abs(acIn() - before) < 0.1, 'the hazard: the memo still serves the moved rows');

    const lines: string[] = [];
    assert.equal(reports.noteSamplesGeneration(rr.samplesGeneration!(), (m) => lines.push(m)), true, '★★★ the next request sees the generation move');
    assert.match(lines.join('\n'), /rows were moved out of \(or back into\) samples \(generation 0 → \d+\): closed-day memos and report caches reset/);
    const after = acIn();
    assert.ok(after < 3, `★★★ only what was measured: ${after.toFixed(2)} kWh (was ${before.toFixed(1)})`);
    assert.equal(heldBuckets(), 0, '★★ the health series is re-read without them');
    assert.equal(reports.noteSamplesGeneration(rr.samplesGeneration!()), false, 'no further move, no further reset');
  } finally {
    rr.close();
    rec.close();
    reports.resetReportBasisForTesting();
    resetDailyEnergyCache();
    resetEquipmentHealthCaches();
  }
});

test('★★ buildReport checks the generation before every report and resets the memos when it moved', async () => {
  const now = Date.now();
  const todayStart = startOfLocalDayMs(new Date(now));
  const yStart = startOfLocalDayMs(new Date(todayStart - 12 * H));
  let gen = 7;
  let closedDayReads = 0;
  const rec = makeRecorderStub({
    samplesGeneration: () => gen,
    queryMulti: (_sn, metrics, since) => {
      if (since < todayStart - H) closedDayReads++;
      return new Map(metrics.map((m) => [m, [] as Array<{ ts: number; value: number }>]));
    },
  });
  const ctx = { recorder: rec, snapshot: { generatedAt: now, devices: {} }, log: () => {} };
  reports.resetReportBasisForTesting();
  resetDailyEnergyCache();
  try {
    const integrate = () => windowedEnergyWh(rec, SN, ['ac_in'], yStart, now, 60, todayStart);
    await reports.buildReport('thermalEvents', ctx);
    integrate();
    const first = closedDayReads;
    assert.ok(first >= 1, 'the closed day is read once …');
    integrate();
    await reports.buildReport('thermalEvents', ctx);
    integrate();
    assert.equal(closedDayReads, first, '… and memoised while the generation stands');
    gen = 8; // a held-sample move committed on the main thread
    await reports.buildReport('thermalEvents', ctx);
    integrate();
    assert.equal(closedDayReads, 2 * first, '★★ the report after the move cleared the memo: the closed day is read again');
  } finally {
    reports.resetReportBasisForTesting();
    resetDailyEnergyCache();
  }
});
