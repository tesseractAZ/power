/**
 * v1.187.3 — `delivered_basis` round-trips through the ledger, and the buy de-bias learner reads
 * it from the rows the recorder returns.
 *
 * recordNightOutcome IGNORES a column missing from its allowlist rather than throwing, so a
 * basis dropped from NIGHT_LEDGER_COLUMNS (or from the ALTER migration) would vanish without an
 * error — and with it every new night, which the learner would then set aside as legacy for
 * good. This proves the round trip on a real database, the learner's split over what comes
 * back, and (as pins) the scorer's wiring in index.ts, which no test drives.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Point the recorder at a throwaway DB BEFORE it (→ config.ts) is imported.
const tmp = mkdtempSync(join(tmpdir(), 'ef-nc-delivered-basis-'));
process.env.DB_PATH = join(tmp, 'ecoflow.db');
after(() => rmSync(tmp, { recursive: true, force: true }));

const { createRecorder } = await import('../src/recorder.js');
const { SnapshotStore } = await import('../src/snapshot.js');
const { calibratedBuyDebiasFactor, DELIVERED_BASIS } = await import('../src/nightChargeAdvisor.js');

const DAY = 86_400_000;
const BASE = Date.UTC(2026, 9, 20, 6); // a Monday 23:00 MST

function planRow(planDate: string, i: number) {
  return {
    plan_date: planDate, issued_at_ms: BASE + i * DAY - 90 * 60_000, algo_version: 'nc-v1', posture: 'supervised',
    objective: 'cost_arbitrage', confidence_tier: 'forecast', reserve_floor_pct: 16, cushion_pct: 10,
    buy_kwh: 20, window_start_ms: BASE + i * DAY, window_end_ms: BASE + i * DAY + 6 * 3_600_000,
  };
}

test('★★★ delivered_basis round-trips, and the learner splits the ledger on it', () => {
  const rec = createRecorder(new SnapshotStore(), () => {});
  try {
    // Two nights captured before v1.187.3 (no basis), seven on the current basis.
    const dates = Array.from({ length: 9 }, (_, i) => `2026-10-${String(20 + i).padStart(2, '0')}`);
    dates.forEach((d, i) => {
      rec.recordNightPlan(planRow(d, i) as any);
      rec.recordNightOutcome(d, { actuated: 1, cushion_shortfall: 0 } as any);
      const legacy = i < 2;
      rec.recordNightOutcome(d, {
        outcome_captured_at_ms: BASE + i * DAY + 22 * 3_600_000, scored: 1,
        delivered_kwh: legacy ? 5.2 : 28,
        ...(legacy ? {} : { delivered_basis: DELIVERED_BASIS }),
      });
    });
    const rows = rec.readNightLedger(100_000).filter((r) => dates.includes(String(r.plan_date)));
    assert.equal(rows.length, 9);
    assert.deepEqual(rows.map((r) => r.delivered_basis), [null, null, ...Array(7).fill(DELIVERED_BASIS)],
      'the basis is persisted beside the value; a legacy row reads NULL');
    assert.equal(rows[0].delivered_kwh, 5.2, 'the legacy value is kept as recorded');
    const cal = calibratedBuyDebiasFactor(rows);
    assert.deepEqual(cal, { factor: 1.4, basis: 'measured', samples: 7, setAside: 2 });
    // Without the column the seven new nights would read as legacy: nothing measured.
    const stripped = calibratedBuyDebiasFactor(rows.map((r) => ({ ...r, delivered_basis: null })));
    assert.deepEqual(stripped, { factor: 1, basis: 'default', samples: 0, setAside: 9 });
  } finally {
    rec.close();
  }
});

/* ══ integration pins: index.ts scoreNightRow and the learner's log ══ */
const INDEX = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/index.ts'), 'utf8');
const fnBody = (sig: string) => { const i = INDEX.indexOf(sig); assert.ok(i > 0, sig); return INDEX.slice(i, INDEX.indexOf('\n}\n', i)); };

test('★★ the scorer reads the HOUSE panel\'s connected channels and writes the basis from the assembly', () => {
  // The measurement and its gates are driven in ledgerDeliveredIntoCores.test.ts; this pins
  // only that index.ts feeds it the house panel's own slots and writes what it returns.
  const b = fnBody('function scoreNightRow(');
  assert.ok(b.includes('  const housePanel = store.get().devices[shp2Sn];'));
  assert.ok(b.includes("    housePanel?.projection?.kind === 'shp2' ? (housePanel.projection as Shp2Projection).sources : null,"));
  assert.ok(b.includes('    sourceChannels,\n  });'));
  assert.ok(b.includes('    delivered_kwh: deliveredKwh,'));
  assert.ok(b.includes('    delivered_basis: cols.deliveredBasis,'));
  assert.ok(b.includes('const deliveredKwh = cols.deliveredKwh;'));
});

test('★★ the unmeasured log line names the set-aside rows and changes when they do', () => {
  assert.match(INDEX, /const key = `unmeasured:\$\{buyDebiasCal\.samples\}:\$\{buyDebiasCal\.setAside\}`;/);
  assert.match(INDEX, /\$\{buyDebiasCal\.setAside\} set aside for a pre-v1\.187\.3 delivered_kwh/);
});
