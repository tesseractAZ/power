/**
 * v1.187.10 (log review 10-03, MEDIUM) — the degradation report's regression window comes from the
 * configured samples retention (120-365 days), so a plausible linear fade can reach 'projecting'.
 *
 * The window was fixed at 30 days ("= recorder RETAIN_MS", a premise retired when retention became
 * configurable in v1.51.0; 1825 days on the reviewed install). Over 30 days sohSignalBelowFloor's
 * 1.5-pt quartile-drop floor needs a linear fade of about 24 %/yr, and fadeExceedsPlausibleCeiling
 * rejects anything above 10 %/yr, so no linear fade could ever project: HA ..._soonest_pack_eol had
 * no numeric value in its whole retained history while forecast-soh (120 days) reported two packs
 * declining ~9-10 %/yr. Device and pack ids are made up.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { DeviceSnapshot } from '../src/snapshot.js';
import { makeRecorderStub } from './helpers/recorderStub.js';

const TMP = mkdtempSync(join(tmpdir(), 'ef-degrade-window-'));
process.env.LIGHTING_POSTURE_STATE_PATH = join(TMP, 'lighting-posture.json');
process.env.DATA_DIR = TMP;
after(() => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });

const realNow = Date.now.bind(Date);
let offset = 0;
Date.now = () => realNow() + offset;
const DAY = 86_400_000;
/** computeDegradation caches its report for 30 min: step past it between scenarios. */
const pastCache = () => { offset += 31 * 60_000; };

const analytics = await import('../src/analytics.js');
const { computeDegradation, degradationWindowDays, DEGRADE_WINDOW_MIN_DAYS, DEGRADE_WINDOW_MAX_DAYS,
  SOH_MIN_OBSERVED_DROP_PTS, EOL_MAX_FADE_PCT_PER_YEAR } = analytics;
const { soonestProjecting } = await import('../src/haPayloadFmt.js');

const SN = 'COREXXX00XXX0001';

/** A deterministic, small jitter (±0.05 pt) so the 6-hour bucket means are not exact flats. */
function jitter(i: number): number {
  const x = Math.sin(i * 12.9898) * 43758.5453;
  return ((x - Math.floor(x)) - 0.5) * 0.1;
}
/** 6-hour-bucketed SoH fading linearly at `fadePerYear` over the last `days` days, ending at `endSoh`. */
function fadeSeries(nowMs: number, days: number, fadePerYear: number, endSoh: number): Array<{ ts: number; value: number }> {
  const step = 6 * 3_600_000;
  const n = Math.floor((days * DAY) / step);
  const out: Array<{ ts: number; value: number }> = [];
  for (let i = 0; i <= n; i++) {
    const ts = nowMs - (n - i) * step;
    const ageYears = (nowMs - ts) / (365.25 * DAY);
    out.push({ ts, value: endSoh + fadePerYear * ageYears + jitter(i) });
  }
  return out;
}
function dpu(sn: string, actSoh: number): DeviceSnapshot {
  return {
    sn, deviceName: 'Core 1', productName: 'DELTA Pro Ultra', online: true, lastUpdated: Date.now(),
    projection: {
      kind: 'dpu', soc: 80,
      packs: [{ num: 1, soc: 80, soh: actSoh, actSoh, cycles: 150, temp: 25, packSn: 'PACKXXX00XXX0001',
        designCapMah: 60_000, fullCapMah: 56_000, accuChgMah: null, accuDsgMah: null }],
    },
  } as unknown as DeviceSnapshot;
}
function recorderWith(series: Array<{ ts: number; value: number }>) {
  const pick = (since: number, until: number) => series.filter((p) => p.ts >= since && p.ts <= until);
  const windows: number[] = [];
  return {
    windows,
    rec: makeRecorderStub({
      query: () => [],
      queryMulti: (_sn: string, metrics: string[], since: number, until: number) => {
        windows.push(until - since);
        const m = new Map<string, Array<{ ts: number; value: number }>>();
        for (const k of metrics) m.set(k, k.endsWith('_soh') ? pick(since, until) : []);
        return m;
      },
    }),
  };
}

test('degradationWindowDays — the configured retention, clamped to [120, 365] days', () => {
  assert.equal(DEGRADE_WINDOW_MIN_DAYS, 120, 'the forecast-soh window, so the dated EOL and forecast-soh agree');
  assert.equal(DEGRADE_WINDOW_MAX_DAYS, 365);
  assert.equal(degradationWindowDays(30), 120, 'the retention default: the floor (fewer rows, same window)');
  assert.equal(degradationWindowDays(200), 200);
  assert.equal(degradationWindowDays(1825), 365, 'a multi-year retention: capped at a year');
  assert.equal(degradationWindowDays(7), 120);
});

test('★★ the gate chain can be satisfied at the floor: the 1.5-pt quartile drop is reachable below the 10 %/yr ceiling', () => {
  // A linear fade f over W days moves the quartile means 0.75·W·f/365.25 points apart.
  assert.equal(SOH_MIN_OBSERVED_DROP_PTS, 1.5);
  assert.equal(EOL_MAX_FADE_PCT_PER_YEAR, 10);
  assert.ok(0.75 * DEGRADE_WINDOW_MIN_DAYS * EOL_MAX_FADE_PCT_PER_YEAR / 365.25 >= SOH_MIN_OBSERVED_DROP_PTS);
  assert.ok(0.75 * 30 * EOL_MAX_FADE_PCT_PER_YEAR / 365.25 < SOH_MIN_OBSERVED_DROP_PTS, 'the former 30-day window could not');
});

test('★★★ an 8 %/yr linear fade with 120 days of history reaches "projecting", with a dated EOL (soonestProjecting is non-null)', async () => {
  process.env.RECORDER_RETENTION_DAYS = '1825';
  pastCache();
  const now = Date.now();
  const { rec, windows } = recorderWith(fadeSeries(now, 120, 8, 94.0));
  const report = await computeDegradation({ [SN]: dpu(SN, 94.0) }, rec);
  assert.equal(report.windowDays, 365, 'retention 1825 d → the 365-day cap');
  assert.ok(windows.some((w) => w >= 365 * DAY - 1_000), 'the SoH history is read over the whole window');
  const p = report.packs[0];
  assert.equal(p.status, 'projecting', p.summary);
  assert.ok(p.fadePctPerYear != null && p.fadePctPerYear > 7 && p.fadePctPerYear < 9, `fade ${p.fadePctPerYear}`);
  assert.ok(p.yearsToEol != null && p.yearsToEol > 1.5 && p.yearsToEol < 2.2, `years to EOL ${p.yearsToEol}`);
  const { soonest } = soonestProjecting(report.packs);
  assert.ok(soonest != null && soonest.yearsToEol === p.yearsToEol, 'the HA Soonest Pack EOL sensor has a value');
});

test('★★ the window follows the retention: 200 days configured reads 200 days', async () => {
  process.env.RECORDER_RETENTION_DAYS = '200';
  pastCache();
  const now = Date.now();
  const { rec, windows } = recorderWith(fadeSeries(now, 120, 8, 94.0));
  const report = await computeDegradation({ [SN]: dpu(SN, 94.0) }, rec);
  assert.equal(report.windowDays, 200);
  assert.ok(windows.length > 0 && windows.every((w) => Math.abs(w - 200 * DAY) < 1_000), 'queried over 200 days');
  assert.equal(report.packs[0].status, 'projecting');
});

test('the same fade with only 30 days of history stays "learning" (below the noise floor) — why the window must reach ≥ 73 days', async () => {
  process.env.RECORDER_RETENTION_DAYS = '1825';
  pastCache();
  const now = Date.now();
  const { rec } = recorderWith(fadeSeries(now, 30, 8, 94.0));
  const report = await computeDegradation({ [SN]: dpu(SN, 94.0) }, rec);
  assert.equal(report.packs[0].status, 'learning');
  assert.match(report.packs[0].summary, /only a fraction of a percent/);
  delete process.env.RECORDER_RETENTION_DAYS;
});

test('★★ the configured retention reaches the analytics worker thread (the real worker, spawned as in production)', { timeout: 30_000 }, async () => {
  // The worker's process.env is a copy of the parent's at spawn; the report says which window it used.
  const dbPath = join(TMP, 'worker.db');
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE samples (ts INTEGER, sn TEXT, metric TEXT, value REAL); CREATE INDEX idx ON samples (sn, metric, ts);');
  db.close();
  process.env.RECORDER_RETENTION_DAYS = '240';
  const { createAnalyticsClient } = await import('../src/analyticsClient.js');
  const logs: string[] = [];
  const client = createAnalyticsClient(dbPath, (m) => logs.push(m), { firstSnapshotWaitMs: 10 });
  try {
    const report = await client.report<{ windowDays?: number; packs: unknown[] }>('degradation');
    assert.equal(report.windowDays, 240, `the worker read RECORDER_RETENTION_DAYS; log:\n${logs.join('\n')}`);
    assert.deepEqual(report.packs, []);
  } finally {
    client.stop();
    delete process.env.RECORDER_RETENTION_DAYS;
  }
});
