/**
 * v1.187.10 (log review 10-03, C30) — the GHI persistence tick says what it did, and says nothing
 * the recorder already said.
 *
 * "weather: periodic GHI persistence (264 hours)" was logged after every 45-minute tick: 54
 * byte-identical lines in 40.8 h, 35 of them on ticks that wrote nothing, and the 264 was the
 * forecast series' length, not a row count. recordWeatherGhi now returns what it wrote; the tick
 * logs "nothing new" at most every 6 h, "no forecast" on entering that state, and nothing on a tick
 * that wrote (the recorder logs those rows itself).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'ef-ghi-tick-'));
process.env.DB_PATH = join(tmp, 'ecoflow.db');
after(() => rmSync(tmp, { recursive: true, force: true }));

const { createRecorder } = await import('../src/recorder.js');
const { SnapshotStore } = await import('../src/snapshot.js');
const { createGhiTickLogger, GHI_TICK_QUIET_HEARTBEAT_MS } = await import('../src/weather.js');

const HOUR = 3_600_000;
const BASE = 1_700_000_000_000 - (1_700_000_000_000 % HOUR);
const hours = [
  { epochMs: BASE + 0 * HOUR, radiationWm2: 120, cloudCoverPct: 40 },
  { epochMs: BASE + 1 * HOUR, radiationWm2: 350, cloudCoverPct: 15 },
  { epochMs: BASE + 2 * HOUR, radiationWm2: 610, cloudCoverPct: 5 },
];

test('★★★ the real recorder reports what each call wrote, and the tick line follows it: silent when rows were written, "nothing new" once per 6 h, "no forecast" once', () => {
  const rec = createRecorder(new SnapshotStore(), () => {});
  const lines: string[] = [];
  const tick = createGhiTickLogger((m) => lines.push(m));
  const run = (nowMs: number) => {
    const r = rec.recordWeatherGhi(hours, { fetchedAtMs: BASE + 4 * HOUR });
    assert.ok(r, 'the write path reports its counts');
    tick({ kind: 'ran', hours: hours.length, written: r.written, realized: r.realizedInserted + r.realizedRevised }, nowMs);
    return r;
  };
  try {
    const t0 = BASE + 5 * HOUR;
    assert.deepEqual(run(t0), { written: 6, realizedInserted: 3, realizedRevised: 0 }, 'three GHI + three cloud rows, three realized hours');
    assert.deepEqual(lines, [], 'rows were written: the recorder logged them, the tick adds nothing');
    assert.deepEqual(run(t0 + 45 * 60_000), { written: 0, realizedInserted: 0, realizedRevised: 0 });
    assert.deepEqual(lines, ['weather: GHI persistence tick — nothing new to store (the 3-hour series is already recorded); repeated at most every 6 h while nothing changes']);
    for (let k = 2; k * 45 * 60_000 < 45 * 60_000 + GHI_TICK_QUIET_HEARTBEAT_MS; k++) run(t0 + k * 45 * 60_000);
    assert.equal(lines.length, 1, 'no repeat inside 6 h — not one line per tick');
    run(t0 + 45 * 60_000 + GHI_TICK_QUIET_HEARTBEAT_MS);
    assert.equal(lines.length, 2, 'the 6-hour heartbeat: the tick is alive');

    tick({ kind: 'no-weather' }, t0 + 10 * HOUR);
    tick({ kind: 'no-weather' }, t0 + 11 * HOUR);
    assert.deepEqual(lines.slice(2), ['weather: GHI persistence tick — no forecast available (the fetch failed or has not run); nothing stored']);
    run(t0 + 12 * HOUR);
    assert.equal(lines[3], 'weather: GHI persistence tick — forecast available again (0 new row(s), 0 realized hour(s))');
    assert.ok(!lines.some((l) => /periodic GHI persistence \(\d+ hours\)/.test(l)), 'no series-length claim');
  } finally {
    rec.close();
  }
});
