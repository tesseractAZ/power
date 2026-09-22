import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * v1.175.0 — a panel that reported no channel watts writes NO panel_load row.
 *
 * The SHP2 projection always carries twelve channel entries, with `watts: null` for any
 * the payload omitted. The recorder started its sum at 0, so a panel that reported nothing
 * was stored as "the house drew 0 W" — a row no consumer can tell from a real zero: the
 * Today tiles integrate it, the night-charge load model and its band calibration learn
 * from it, and the grid-KPI coverage gate compares grid_home_w coverage against it.
 * A missing reading is now a coverage gap, which every one of those consumers already
 * handles honestly.
 */
const tmp = mkdtempSync(join(tmpdir(), 'ef-panel-silent-'));
process.env.DB_PATH = join(tmp, 'ecoflow.db');
const { createRecorder } = await import('../src/recorder.js');
const { SnapshotStore } = await import('../src/snapshot.js');

const shp2 = (watts: Array<number | null>, gridWatt: number) => ({
  sn: 'SHP2', deviceName: 'SHP2', productName: 'Smart Home Panel 2', online: true, lastUpdated: 0,
  projection: {
    kind: 'shp2',
    circuits: watts.map((w, i) => ({ ch: i + 1, name: `Circuit ${i + 1}`, watts: w, setAmp: null, linkCh: null, linkMark: false, loadPriority: null, loadIsEnable: null })),
    pairedCircuits: [], sources: [], sourceWatts: [], gridWatt,
  },
});

test('★★★ twelve null channels record NO panel_load — silence is a gap, not a 0 W sample', () => {
  const rec = createRecorder(new SnapshotStore(), () => {});
  try {
    // Rows are stamped at insert time, so the window brackets the insert itself.
    const t0 = Date.now();
    rec.insertSnapshot({ generatedAt: t0, devices: { SHP2: shp2(Array(12).fill(null), 0) } } as any);
    const t0e = Date.now();
    assert.deepEqual(rec.query('SHP2', 'panel_load', t0 - 1000, t0e + 1000), [], 'no row, so no consumer can integrate a fabricated zero');
    // The grid reading on the same payload still records — only the missing figure is skipped.
    assert.equal(rec.query('SHP2', 'grid_home_w', t0 - 1000, t0e + 1000).length, 1);
  } finally { rec.close(); }
});

test('a partial payload records the sum of the channels it DID report', () => {
  const rec = createRecorder(new SnapshotStore(), () => {});
  try {
    const t1 = Date.now();
    rec.insertSnapshot({ generatedAt: t1, devices: { SHP2: shp2([500, 250, ...Array(10).fill(null)], 0) } } as any);
    const rows = rec.query('SHP2', 'panel_load', t1 - 1000, Date.now() + 1000);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].value, 750, 'a partial payload sums the channels it DID report');
  } finally { rec.close(); }
});

test('channels that REPORTED 0 W are a real measurement and are kept', () => {
  // A fresh recorder: the write throttle (MIN_INTERVAL_MS per metric) is per instance.
  const rec = createRecorder(new SnapshotStore(), () => {});
  try {
    const t2 = Date.now();
    rec.insertSnapshot({ generatedAt: t2, devices: { SHP2: { ...shp2(Array(12).fill(0), 0), sn: 'SHP2B' } } } as any);
    const rows = rec.query('SHP2B', 'panel_load', t2 - 1000, Date.now() + 1000);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].value, 0, 'a reported zero is not silence');
  } finally { rec.close(); rmSync(tmp, { recursive: true, force: true }); }
});
