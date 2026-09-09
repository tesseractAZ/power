import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeAlerts } from '../src/alerts.js';
import type { DeviceSnapshot } from '../src/snapshot.js';
import {
  confirmDefectivePack, markPackPresent, getConfirmedRecord,
  DEFECTIVE_PACK_ABSENT_RETIRE_MS, _resetDefectivePackLatchForTests,
} from '../src/defectivePackLatch.js';
import { saveNotifiedState, loadNotifiedState, type NotifyRecord } from '../src/alertMonitor.js';

/**
 * v1.140.0 — the evidence gates are only as good as their wiring.
 *
 * Each fix in this release extracts a pure decision and then feeds it from a
 * live call site. The mutation harness found that three of those call sites
 * could be reverted with every unit test still green — the same shape as the
 * v0.33 dead `M` key, which was wired, tested and mutation-proven while the
 * production source literal omitted it. These pin the wiring.
 */

const CORE = 'Y711ZABA9H3T0489';
const PACK = 'Y712ZABA4H350037';

const packFull = (num: number, soc: number, inW: number, cells: number[]) => ({
  num, soc, soh: 100, actSoh: 100, inputWatts: inW, outputWatts: 0, cycles: 100,
  temp: 30, maxCellTemp: 30, minCellTemp: 30,
  cellVoltagesMv: cells,
  maxVolDiffMv: Math.max(...cells) - Math.min(...cells),
});

function defectivePacks() {
  const bad = new Array(32).fill(3125); bad[30] = 3019;
  const ok = () => new Array(32).fill(3330);
  return [
    { ...packFull(1, 1, 0, bad), packSn: PACK },
    packFull(2, 48, 420, ok()), packFull(3, 49, 380, ok()),
    packFull(4, 45, 358, ok()), packFull(5, 49, 351, ok()),
  ];
}

function fleet(packs: unknown[], online: boolean): Record<string, DeviceSnapshot> {
  return {
    [CORE]: {
      sn: CORE, deviceName: 'Core 4', productName: 'DELTA Pro Ultra',
      online, lastSeenMs: Date.now(),
      projection: { kind: 'dpu', soc: 40, packs } as never,
    } as never,
  };
}

// ── R2(b): the DPU loop stamps its source device ─────────────────────────────

test('★ every alert a DPU emits carries its sourceSn', () => {
  // Without this the boot orphan sweep has nothing to gate on:
  // fallingEdgeFrozenByEvidence falls back to scanning the id, which resolves
  // nothing for dpu-err-* / vdiff-crit-*, so those ids would still be resolved
  // on a restart while the Core is cloud-dark.
  const alerts = computeAlerts(fleet(defectivePacks(), true), undefined, { present: true, backstopping: true });
  const fromCore = alerts.filter((a) => a.id.includes(CORE));
  assert.ok(fromCore.length > 0, 'the fixture must emit at least one Core alert');
  const unstamped = fromCore.filter((a) => a.sourceSn !== CORE).map((a) => a.id);
  assert.deepEqual(unstamped, [], 'every DPU-loop alert must name its source device');
});

// ── R4: the evaluable set must not drift from the loop gate ──────────────────

test('★ an OFFLINE Core is not in the retirement evaluable set (integration)', () => {
  // `dpus` is filtered on projection.kind, so an offline Core IS in it — the
  // only thing keeping it out of the evaluable set is the shared isDpuEvaluable
  // predicate. If the set were built from a bare `dpus.map(...)`, this Core's
  // silence would count as evidence and the warranty record would be deleted.
  _resetDefectivePackLatchForTests(join(mkdtempSync(join(tmpdir(), 'latch-')), 'latch.json'));
  confirmDefectivePack(
    { packSn: PACK, deviceSn: CORE, deviceName: 'Core 4', packNum: 1,
      socPct: 1, siblingMedianSocPct: 86, packAbsW: 1, siblingMedianAbsW: 350,
      deviantCell: 31, deltaMv: -115 } as never,
    1_000,
  );
  markPackPresent(PACK, 1_000, CORE);

  // The Core goes cloud-dark and stays dark well past the 48 h horizon.
  const dark = fleet(defectivePacks(), false);
  for (let h = 1; h <= 60; h++) {
    computeAlerts(dark, undefined, { present: true, backstopping: true });
  }
  assert.ok(
    getConfirmedRecord(PACK),
    'a dark chassis cannot supply evidence that its pack departed — the RMA record must survive',
  );
  void DEFECTIVE_PACK_ABSENT_RETIRE_MS;
});

// ── R2(a): sourceSn survives the persistence round trip ──────────────────────

test('sourceSn round-trips through the notified-state sidecar', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'notif-')), 'notified.json');
  const now = Date.now();
  const state = new Map<string, NotifyRecord>([
    ['dpu-err-CORE4', { ts: now, sent: true, sev: 'critical', title: 'Battery protection fault', sourceSn: CORE }],
    ['legacy-id', { ts: now, sent: true, sev: 'warning' }], // pre-v1.140.0 shape
  ]);
  saveNotifiedState(path, state);
  const back = loadNotifiedState(path, now);
  assert.equal(back.get('dpu-err-CORE4')?.sourceSn, CORE);
  assert.equal(back.get('legacy-id')?.sourceSn, undefined, 'a legacy record loads without throwing');
});

test('★ BRIDGE: the live notify write persists sourceSn', () => {
  // The write is inside evaluate()'s closure and not reachable from a test.
  const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/alertMonitor.ts'), 'utf8');
  // There are two set sites: one spreads an existing record (`{...liveRec}`,
  // which preserves sourceSn for free) and one BUILDS a fresh record. Only the
  // second can drop the field, so target it explicitly.
  const i = src.indexOf('persistedNotified.set(a.id, { ts: now, sent:');
  assert.ok(i > 0, 'the fresh-record notify persist site is located');
  const call = src.slice(i, src.indexOf('});', i));
  assert.match(
    call, /sourceSn: a\.sourceSn/,
    'the persisted record must carry sourceSn — the id-scan fallback resolves nothing for shp2-src-err-* and friends, which are the alarm data source’s OWN alerts',
  );
});

test('★ BRIDGE: the retirement evaluable set is built from the shared predicate', () => {
  const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/alerts.ts'), 'utf8');
  const i = src.indexOf('retireAbsentPacks({');
  assert.ok(i > 0, 'the retireAbsentPacks call site is located');
  const call = src.slice(i, src.indexOf('})', i));
  assert.match(
    call, /dpus\.filter\(isDpuEvaluable\)/,
    'the evaluable set must use the SAME predicate that gates the pack loop — a second, drifting filter would reintroduce exactly the shape this release closes',
  );
});
