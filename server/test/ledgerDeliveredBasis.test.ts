/**
 * v1.187.3 — `delivered_basis` round-trips through the ledger, and the buy de-bias learner reads
 * it from the rows the recorder returns.
 *
 * recordNightOutcome IGNORES a column missing from its allowlist rather than throwing, so a
 * basis dropped from NIGHT_LEDGER_COLUMNS (or from the ALTER migration) would vanish without an
 * error — and with it every new night, which the learner would then set aside as legacy for
 * good. This proves the round trip on a real database and the learner's split over what comes
 * back; and (review) the scorer's capture chain, driven rather than pinned: a SnapshotStore
 * holding two projected panels → houseConnectedSlots → assembleNightLedgerColumns →
 * deliveredLedgerFields → the ledger → the learner, plus the learner's UNMEASURED line.
 * index.ts keeps only the two call sites (`houseConnectedSlots(store.get().devices, shp2Sn)`
 * and `...deliveredLedgerFields(cols)`), beside the query seam they share.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Point the recorder at a throwaway DB BEFORE it (→ config.ts) is imported.
const tmp = mkdtempSync(join(tmpdir(), 'ef-nc-delivered-basis-'));
process.env.DB_PATH = join(tmp, 'ecoflow.db');
after(() => rmSync(tmp, { recursive: true, force: true }));

const { createRecorder } = await import('../src/recorder.js');
const { SnapshotStore } = await import('../src/snapshot.js');
const { calibratedBuyDebiasFactor, buyDebiasUnmeasuredLogLine, DELIVERED_BASIS } = await import('../src/nightChargeAdvisor.js');
const { houseConnectedSlots, assembleNightLedgerColumns, deliveredLedgerFields } = await import('../src/nightLedgerScoring.js');

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

/* ══ the scorer's capture chain, driven (review: these were source pins on index.ts) ══ */

const MIN = 60_000;
const HOUR = 3_600_000;
type Pt = { ts: number; value: number };
const series = (from: number, to: number, w: (t: number) => number): Pt[] => {
  const out: Pt[] = [];
  for (let t = from; t <= to; t += MIN) out.push({ ts: t, value: w(t) });
  return out;
};
const HOUSE = 'PANEXXX00XXX0002';
const GARAGE = 'PANEXXX00XXX0001'; // the LOWER serial: the panel a "first SHP2" lookup would find
/** A panel's quota: slot n connected (with a serial) when listed, and its chWatt. */
const panelQuota = (connected: number[], chWatt: number[]) => {
  const q: Record<string, unknown> = { 'backupInfo.chWatt': chWatt, 'loadInfo.hall1Watt': Array(12).fill(100) };
  for (const n of [1, 2, 3]) {
    q[`pd303_mc.backupIncreInfo.Energy${n}Info.devInfo.modelInfo.sn`] = `COREXXX00XXX000${n}`;
    q[`pd303_mc.backupIncreInfo.Energy${n}Info.isConnect`] = connected.includes(n) ? 1 : 0;
  }
  return q;
};
function plantStore(houseConnected: number[]) {
  const store = new SnapshotStore();
  store.setLogger(() => {});
  store.setDeviceList([
    { sn: GARAGE, deviceName: 'Garage Panel', productName: 'Smart Home Panel 2', online: 1 },
    { sn: HOUSE, deviceName: 'House Panel', productName: 'Smart Home Panel 2', online: 1 },
  ] as any);
  store.setDeviceQuota(GARAGE, panelQuota([1], [0, 0, 0]));
  store.setDeviceQuota(HOUSE, panelQuota(houseConnected, [-500, -500, -500]));
  return store;
}

test('★★★ capture chain: the house panel\'s slots → the assembly → the ledger fields → the learner', () => {
  const ws = BASE + 30 * DAY;
  const we = ws + 6 * HOUR;
  // Three channels charged 4 kW each for the whole window; the meter imported it all.
  const data: Record<string, Pt[]> = {
    grid_home_w: series(ws - HOUR, we + 17 * HOUR, (t) => (t >= ws && t < we ? 14_000 : 1_500)),
    src1_w: series(ws - HOUR, we + 17 * HOUR, (t) => (t >= ws && t < we ? 4_000 : -300)),
    src2_w: series(ws - HOUR, we + 17 * HOUR, (t) => (t >= ws && t < we ? 4_000 : -300)),
    src3_w: series(ws - HOUR, we + 17 * HOUR, (t) => (t >= ws && t < we ? 4_000 : -300)),
  };
  const capture = (store: InstanceType<typeof SnapshotStore>) => {
    const slots = houseConnectedSlots(store.get().devices, HOUSE);
    return {
      slots,
      cols: assembleNightLedgerColumns({
        row: {
          plan_date: '2026-11-19', issued_at_ms: ws - 90 * MIN,
          actuation_applied_at_ms: ws + 30_000, actuation_reverted_at_ms: we + 30_000, pv_model_sns: null,
        },
        actuated: true, windowStartMs: ws, windowEndMs: we, scoreSpanEndMs: we + 16 * HOUR,
        onpeak: null, supersededBy: null,
        query: (m: string, a: number, b: number) => (data[m] ?? []).filter((p) => p.ts >= a && p.ts <= b),
        rateAt: () => ({ cents: 10, isOnPeak: false, periodId: 'overnight', confirmed: true }) as any,
        homeSns: [], houseConnectedSlots: slots,
      }),
    };
  };
  // At capture the house panel shows ONE Core connected (two in service); the garage panel's
  // slot 1 is not the house's.
  const one = capture(plantStore([2]));
  assert.deepEqual(one.slots, [2], 'the house panel\'s own slots, by its serial');
  assert.ok(one.cols.deliveredKwh != null && Math.abs(one.cols.deliveredKwh - 72) < 0.2, `three Cores × 4 kW × 6 h: ${one.cols.deliveredKwh}`);
  // A partial quota (no sources subtree): nothing connected, and the hold still measures.
  const none = capture(plantStore([]));
  assert.deepEqual(none.slots, []);
  assert.equal(none.cols.deliveredKwh, one.cols.deliveredKwh);

  const rec = createRecorder(new SnapshotStore(), () => {});
  try {
    const dates = Array.from({ length: 7 }, (_, i) => `2026-11-${String(20 + i).padStart(2, '0')}`);
    dates.forEach((d, i) => {
      rec.recordNightPlan({ ...planRow(d, 31 + i), buy_kwh: 60 } as any);
      rec.recordNightOutcome(d, { actuated: 1, cushion_shortfall: 0 } as any);
      rec.recordNightOutcome(d, {
        outcome_captured_at_ms: BASE + (31 + i) * DAY + 22 * HOUR, scored: 1,
        ...deliveredLedgerFields(i % 2 ? one.cols : none.cols),
      });
    });
    const rows = rec.readNightLedger(100_000).filter((r) => dates.includes(String(r.plan_date)));
    assert.equal(rows.length, 7);
    for (const r of rows) {
      assert.equal(r.delivered_kwh, one.cols.deliveredKwh);
      assert.equal(r.delivered_basis, DELIVERED_BASIS, 'written with its value, so the learner admits it');
    }
    assert.deepEqual(calibratedBuyDebiasFactor(rows), {
      factor: Math.round((one.cols.deliveredKwh! / 60) * 1000) / 1000, basis: 'measured', samples: 7, setAside: 0,
    }, '~1.2: seven nights on the current basis, none set aside');
  } finally {
    rec.close();
  }
});

test('★★ the recorder writes every chWatt entry as src{n}_w, a slot with no connected Core included', () => {
  // The premise the hold-derived channel set rests on: an unconnected slot reads zeros, so it
  // adds nothing, and every charging channel has rows whatever the membership at capture.
  const store = plantStore([1, 2]);
  store.setDeviceQuota(HOUSE, panelQuota([1, 2], [4_000, 4_000, 0]));
  const rec = createRecorder(new SnapshotStore(), () => {});
  try {
    const t0 = Date.now();
    rec.insertSnapshot(store.get());
    const t1 = Date.now();
    for (const [n, w] of [[1, 4_000], [2, 4_000], [3, 0]] as const) {
      const rows = rec.query(HOUSE, `src${n}_w`, t0 - 1000, t1 + 1000);
      assert.equal(rows.length, 1, `src${n}_w recorded`);
      assert.equal(rows[0].value, w);
    }
  } finally {
    rec.close();
  }
});

/* ══ the learner's UNMEASURED line (review: was a source pin on index.ts) ══ */

test('★★ the unmeasured line names the set-aside rows, and its key changes when they do', () => {
  const a = buyDebiasUnmeasuredLogLine({ basis: 'default', samples: 3, setAside: 6 });
  const b = buyDebiasUnmeasuredLogLine({ basis: 'default', samples: 3, setAside: 7 });
  assert.ok(a && b);
  assert.notEqual(a!.key, b!.key, 'a legacy row scored after the upgrade logs a new line');
  assert.notEqual(a!.key, buyDebiasUnmeasuredLogLine({ basis: 'default', samples: 4, setAside: 6 })!.key);
  assert.match(a!.text, /UNMEASURED \(3 eligible night\(s\), 6 set aside for a pre-v1\.187\.3 delivered_kwh\)/);
  assert.match(a!.text, new RegExp(`delivered_basis is not '${DELIVERED_BASIS}'`));
  assert.equal(buyDebiasUnmeasuredLogLine({ basis: 'measured', samples: 7, setAside: 0 }), null,
    'a measured result has its own line');
});
