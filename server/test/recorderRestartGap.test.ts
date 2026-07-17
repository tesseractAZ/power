import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';

/**
 * v0.80.0 — restart-spanning telemetry-gap detection.
 *
 * The in-process detector (detectTelemetryGap) only compares consecutive
 * in-process inserts, so a blackout that SPANS a restart (host power loss /
 * add-on stop — 3× / ~6.4h in the 68.9h log review) was invisible by
 * construction. createRecorder now compares the newest persisted home-device
 * sample against the boot clock at startup, using the SAME threshold and the
 * SAME recordTelemetryGap sidecar path, marking the gap `restartSpanning`.
 *
 * Hermetic: DB_PATH is a fresh dir captured once at module load (config.ts
 * reads it once at import); every recorder in this file shares it, exactly as
 * real restarts share /data/ecoflow.db. Tests run sequentially and reset the
 * gaps sidecar / samples rows between scenarios.
 */

const tmp = mkdtempSync(join(tmpdir(), 'ef-restart-gap-'));
process.env.DB_PATH = join(tmp, 'ecoflow.db');

const { createRecorder } = await import('../src/recorder.js');
const { SPARE_DPU_SNS } = await import('../src/shp2Membership.js');

const DB_PATH = join(tmp, 'ecoflow.db');
const GAPS_PATH = join(tmp, 'telemetry-gaps.json');
// Mirrors the recorder's GAP_THRESHOLD_MS (3 × MAX_INTERVAL_MS = 15 min).
const GAP_THRESHOLD_MS = 15 * 60_000;

function makeStore() {
  const ee = new EventEmitter() as any;
  ee.snap = { generatedAt: Date.now(), devices: {} };
  ee.get = () => ee.snap;
  return ee;
}

function makeRecorder() {
  const lines: string[] = [];
  const rec = createRecorder(makeStore() as any, (m: string) => lines.push(m));
  return { rec, lines };
}

const gapLines = (lines: string[]) => lines.filter((l) => l.includes('TELEMETRY GAP'));

/** Direct row surgery on the shared DB between recorder "restarts". */
function withRawDb(fn: (db: InstanceType<typeof DatabaseSync>) => void) {
  const db = new DatabaseSync(DB_PATH);
  try { fn(db); } finally { db.close(); }
}

function resetSidecar() {
  if (existsSync(GAPS_PATH)) unlinkSync(GAPS_PATH);
}

test('(a) fresh/empty DB — no restart-spanning gap logged', () => {
  const { rec, lines } = makeRecorder();
  assert.equal(gapLines(lines).length, 0, `fresh DB must not log a gap; got: ${gapLines(lines).join(' | ')}`);
  assert.deepEqual(rec.telemetryGaps(), [], 'fresh DB must have an empty gaps list');
  assert.equal(existsSync(GAPS_PATH), false, 'fresh DB must not create the gaps sidecar');
  rec.close();
});

test('(b) stale home max ts — exactly one gap logged + appended to the sidecar', () => {
  const STALE_MS = 100 * 60_000; // 100 min — well past the 15-min threshold
  const beforeBoot = Date.now();
  const staleTs = beforeBoot - STALE_MS;
  withRawDb((db) => {
    const ins = db.prepare(`INSERT INTO samples (ts, sn, metric, value) VALUES (?, ?, ?, ?)`);
    // The stale HOME sample that defines the gap start.
    ins.run(staleTs, 'DPU_HOME', 'soc', 50);
    // A RECENT spare-SN row must NOT mask the home stall (v0.30.0 semantics)…
    const spareSn = [...SPARE_DPU_SNS][0];
    if (spareSn) ins.run(beforeBoot - 60_000, spareSn, 'soc', 42);
    // …and a FUTURE-stamped weather row (forecast-hour epochs, not wall clock)
    // must not mask it either…
    ins.run(beforeBoot + 2 * 3_600_000, 'weather', 'ghi_wm2', 500);
    // …and (v1.31.0) neither must a RECENT forecast-archive row: the archive
    // tick keeps writing wall-clock-stamped rows while the device feeds are
    // wedged (the forecast is computable from cached model + weather), so an
    // unexcluded 'forecast' SN would pull MAX(ts) past the home stall.
    ins.run(beforeBoot - 30_000, 'forecast', 'pv_next24_wh', 68_000);
  });

  const { rec, lines } = makeRecorder(); // the "restart"
  const afterBoot = Date.now();

  const found = gapLines(lines);
  assert.equal(found.length, 1, `expected exactly one TELEMETRY GAP line, got ${found.length}: ${found.join(' | ')}`);
  assert.match(found[0], /TELEMETRY GAP — no home-device samples for \d+ min/,
    'must share the in-process detector log stem so scanners bucket both variants');
  assert.match(found[0], /spanning a restart \(host down or add-on stopped\)/);
  assert.match(found[0], /history in that window is unrecoverable/);

  const gaps = rec.telemetryGaps();
  assert.equal(gaps.length, 1, 'exactly one gap in the in-memory list');
  const g = gaps[0];
  assert.equal(g.startMs, staleTs, 'gap starts at the stale home sample');
  assert.equal(g.restartSpanning, true, 'gap carries the restart-spanning marker');
  assert.equal(g.durationMs, g.endMs - g.startMs, 'duration is endMs − startMs');
  assert.equal(g.detectedAt, g.endMs, 'detectedAt equals endMs');
  assert.ok(g.durationMs >= STALE_MS && g.endMs <= afterBoot,
    `duration ≈ ${STALE_MS}ms bounded by boot clock; got durationMs=${g.durationMs} endMs=${g.endMs}`);

  // Persisted through the SAME sidecar mechanism the in-process detector uses.
  const persisted = JSON.parse(readFileSync(GAPS_PATH, 'utf8'));
  assert.ok(Array.isArray(persisted) && persisted.length === 1, 'sidecar holds exactly the one gap');
  assert.deepEqual(persisted[0], g, 'sidecar entry matches the surfaced gap (incl. restartSpanning)');
  rec.close();
});

test('(c) recent home max ts — no gap', () => {
  resetSidecar();
  withRawDb((db) => {
    db.prepare(`INSERT INTO samples (ts, sn, metric, value) VALUES (?, ?, ?, ?)`)
      .run(Date.now() - 60_000, 'DPU_HOME', 'soc', 51); // 1 min ago — under threshold
  });
  const { rec, lines } = makeRecorder();
  assert.equal(gapLines(lines).length, 0, `recent max must not log a gap; got: ${gapLines(lines).join(' | ')}`);
  assert.deepEqual(rec.telemetryGaps(), [], 'no gap recorded for a recent max');
  assert.equal(existsSync(GAPS_PATH), false, 'sidecar must not be re-created');
  rec.close();
});

test('(d) stale weather/spare-only rows — excluded SNs never TRIGGER a gap', () => {
  resetSidecar();
  withRawDb((db) => {
    db.exec(`DELETE FROM samples`);
    const ins = db.prepare(`INSERT INTO samples (ts, sn, metric, value) VALUES (?, ?, ?, ?)`);
    const staleTs = Date.now() - 100 * 60_000;
    ins.run(staleTs, 'weather', 'ghi_wm2', 400);
    const spareSn = [...SPARE_DPU_SNS][0];
    if (spareSn) ins.run(staleTs, spareSn, 'soc', 40);
  });
  const { rec, lines } = makeRecorder();
  // With no HOME samples at all, MAX(ts) over the non-excluded SNs is NULL —
  // same as a fresh install; a stale bench spare / weather backfill is not an
  // outage of the home feed.
  assert.equal(gapLines(lines).length, 0, `excluded SNs must not trigger; got: ${gapLines(lines).join(' | ')}`);
  assert.deepEqual(rec.telemetryGaps(), []);
  rec.close();
});

test('(e) v0.80.0 — an ONGOING outage across consecutive boots extends ONE gap record, never duplicates', () => {
  resetSidecar();
  const staleTs = Date.now() - 100 * 60_000; // 100 min ago
  withRawDb((db) => {
    db.prepare(`INSERT INTO samples (ts, sn, metric, value) VALUES (?, ?, ?, ?)`)
      .run(staleTs, 'DPU_HOME', 'soc', 47);
  });
  // Boot 1 — records the restart-spanning gap.
  const first = makeRecorder();
  assert.equal(first.rec.telemetryGaps().filter((g) => g.restartSpanning).length, 1);
  const g1 = first.rec.telemetryGaps().find((g) => g.restartSpanning)!;
  first.rec.close();
  // Boot 2 — the outage is still ongoing (no home sample landed in between):
  // same startMs re-detects; the record must be EXTENDED in place, not appended.
  const second = makeRecorder();
  const restartGaps = second.rec.telemetryGaps().filter((g) => g.restartSpanning);
  assert.equal(restartGaps.length, 1, 'consecutive boots inside one blackout must not append duplicates');
  assert.equal(restartGaps[0].startMs, g1.startMs, 'same outage keeps its original start');
  assert.ok(restartGaps[0].endMs >= g1.endMs, 'the record grows to the newest detection instant');
  assert.equal(restartGaps[0].durationMs, restartGaps[0].endMs - restartGaps[0].startMs);
  second.rec.close();
});
