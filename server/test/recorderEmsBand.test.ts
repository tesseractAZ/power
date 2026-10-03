/**
 * v1.187.3 — the recorder keeps EcoFlow's EMS parallel band beside bat_vol.
 *
 * The ems-volt notice compares batVol with emsParaVolMin/Max, and the band had no series on any
 * release: an episode could only be rebuilt from the cleared ledger's detail text at its edges,
 * never checked against batVol while batVol sat inside the band. Recorded in mV as projected (the
 * pack-cell idiom), so a band move lands when it happens rather than at the 5-minute heartbeat.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

const tmp = mkdtempSync(join(tmpdir(), 'ef-ems-band-rec-'));
process.env.DB_PATH = join(tmp, 'ecoflow.db');

const { createRecorder } = await import('../src/recorder.js');

const CORE = 'COREXXX00XXX0005';
const NO_BAND = 'COREXXX00XXX0002';

function makeStore(snap: any) {
  const ee = new EventEmitter() as any;
  ee.snap = snap;
  ee.get = () => ee.snap;
  return ee;
}
function dpu(sn: string, batVol: number | null, minMv: number | null, maxMv: number | null) {
  return {
    sn, deviceName: sn, productName: 'DPU', online: true, lastUpdated: Date.now(),
    projection: {
      kind: 'dpu', soc: 99, packCount: 0, packs: [],
      pvHighWatts: null, pvLowWatts: null, pvTotalWatts: 0, pvHighVolts: null, pvHighAmps: null,
      pvLowVolts: null, pvLowAmps: null, pvHighErrCode: null, pvLowErrCode: null, acInWatts: 0,
      acOutWatts: 0, acOutFreq: null, acOutVol: null, batVol, batAmp: 20, totalInWatts: 0,
      totalOutWatts: 0, remainTimeMin: null, mpptHvTemp: null, mpptLvTemp: null,
      splitPhase: { L11: null, L12: null, L14: null, L21: null, L22: null }, sysErrCode: null,
      emsParaVolMaxMv: maxMv, emsParaVolMinMv: minMv, chgMaxSoc: 100, dsgMinSoc: 0,
    },
  };
}
const flush = () => new Promise((r) => setImmediate(r));

test('★★★ the band is recorded per Core beside bat_vol, in mV, and a missing band writes no row', async () => {
  const t0 = Date.now();
  // 2026-10-01 13:24:57, Core 5: batVol 108.948 V against a 109.4-112.4 V band.
  const store = makeStore({ generatedAt: t0, devices: { [CORE]: dpu(CORE, 108.948, 109_400, 112_400), [NO_BAND]: dpu(NO_BAND, 106.2, null, null) } });
  const rec = createRecorder(store as any, () => {});
  store.emit('change');
  await flush();
  const until = Date.now() + 1_000;
  const series = (sn: string, m: string) => rec.query(sn, m, t0 - 1_000, until).map((p) => p.value);
  assert.deepEqual(series(CORE, 'bat_vol'), [108.948]);
  assert.deepEqual(series(CORE, 'ems_para_vol_min_mv'), [109_400]);
  assert.deepEqual(series(CORE, 'ems_para_vol_max_mv'), [112_400]);
  // One query returns the three together, as an audit of an episode would read them.
  const multi = rec.queryMulti(CORE, ['bat_vol', 'ems_para_vol_min_mv', 'ems_para_vol_max_mv'], t0 - 1_000, until);
  assert.equal(multi.get('ems_para_vol_min_mv')?.length, 1);
  assert.ok(multi.get('bat_vol')![0].value * 1000 < multi.get('ems_para_vol_min_mv')![0].value, 'below the band, as the notice said');
  // A Core that reports no band: bat_vol is recorded, the band is not (null is never a 0).
  assert.deepEqual(series(NO_BAND, 'bat_vol'), [106.2]);
  assert.deepEqual(series(NO_BAND, 'ems_para_vol_min_mv'), []);
  assert.deepEqual(series(NO_BAND, 'ems_para_vol_max_mv'), []);
});
