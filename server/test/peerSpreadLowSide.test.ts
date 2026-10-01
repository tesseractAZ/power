import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { computeLearnedAlerts, _resetPeerHitCounts, PEER_SPREAD_LOW_MUTE_REASON } from '../src/analytics.js';
import { conditionFromAlerts } from '../src/broadcast.js';
import { autoTuneCounts, risingEdgePushes } from '../src/alertMonitor.js';
import type { Alert } from '../src/alerts.js';
import type { DeviceSnapshot } from '../src/snapshot.js';

/* ===================================================================
 * v1.187.1 — the peer cell-spread outlier warns on the HIGH side only (alarms-live-2).
 *
 * 2026-09-30 14:00:08-14:03:48, Core 2: pack 3 reached 100% at 13:56 and relaxed out of the knee
 * first (55 → 23 mV) while its siblings' latest readings were still knee values. Spreads at the
 * raise were [53, 51, 23, 26, 52]: pack 3 sat 28 mV BELOW the median of 51 at z 9.4 and was carded
 * a WARNING — "cell-voltage spread … lower than the sibling-pack median". It ended the charge as
 * the best-balanced pack of five. The low side of a cell spread is the healthy direction; it is
 * now info with annunciate:false (not pushed, not spoken, not counted toward the condition or the
 * auto-tune rollups). The high side, and SoC / SoH in both directions, are unchanged.
 * =================================================================== */

const SN = 'DPU-A';
function core(packs: Array<{ vd: number; soc?: number; soh?: number }>): Record<string, DeviceSnapshot> {
  return {
    [SN]: {
      sn: SN, deviceName: 'Core 2', online: true, lastUpdated: Date.now(),
      projection: {
        kind: 'dpu', soc: 100,
        packs: packs.map((p, i) => ({
          num: i + 1, soc: p.soc ?? 100, maxVolDiffMv: p.vd, packSn: `PACK-${i + 1}`,
          temp: 30, maxCellTemp: 30, soh: p.soh ?? 100, actSoh: p.soh ?? 100,
        })),
      },
    } as unknown as DeviceSnapshot,
  };
}
/** Three consecutive eval cycles (the v0.13.2 emit gate), then every alert of the last one. */
function learned(packs: Array<{ vd: number; soc?: number; soh?: number }>): Alert[] {
  let out: Alert[] = [];
  for (let i = 0; i < 3; i++) out = computeLearnedAlerts(core(packs));
  return out;
}
const byId = (out: Alert[], id: string) => out.find((a) => a.id === id);
const spreads = (vds: number[]) => vds.map((vd) => ({ vd }));

beforeEach(() => _resetPeerHitCounts());

test('★★★ 09-30 14:00, Core 2: pack 3 at 23 mV against a 51 mV median is NOT a warning — info, on screen only', () => {
  const out = learned(spreads([53, 51, 23, 26, 52]));
  const p3 = byId(out, `peer-voldiff-${SN}-3`);
  assert.ok(p3, 'still visible: the card stays');
  assert.match(p3!.detail, /23 mV, 28 mV lower than the sibling-pack median of 51 mV/, 'the fixture reproduces the 09-30 alert');
  assert.ok(Number(p3!.facts!.find((f) => f.label === 'Peer z-score')!.value) >= 5, 'a z-score that used to warn');
  assert.equal(p3!.severity, 'info');
  assert.equal(p3!.annunciate, false, 'not pushed, not spoken');
  assert.equal(p3!.muteReason, PEER_SPREAD_LOW_MUTE_REASON);
  assert.match(p3!.detail, /A lower spread than its siblings is not a fault: shown for reference; not pushed or announced\./);
  // Pack 4 had relaxed too (26 mV): the low side, the same.
  const p4 = byId(out, `peer-voldiff-${SN}-4`);
  assert.equal(p4?.severity, 'info');
  assert.equal(p4?.annunciate, false);
  // What that means downstream: no push, no condition, no auto-tune rise.
  assert.equal(risingEdgePushes(p3!), false);
  assert.equal(autoTuneCounts(p3!), false);
  assert.equal(conditionFromAlerts([p3!, p4!]).level, 'green');
});

test('★★★ the HIGH side still warns and annunciates: Core 2 at 13:59, pack 4 at 67 mV against a 52 mV median', () => {
  const out = learned(spreads([53, 51, 23, 67, 52]));
  const p4 = byId(out, `peer-voldiff-${SN}-4`);
  assert.ok(p4);
  assert.match(p4!.detail, /higher than the sibling-pack median/);
  assert.equal(p4!.severity, 'warning');
  assert.equal(p4!.annunciate, undefined, 'annunciating');
  assert.equal(p4!.muteReason, undefined);
  assert.doesNotMatch(p4!.detail, /not a fault/);
  // …while pack 3, below the median in the same tick, does not.
  assert.equal(byId(out, `peer-voldiff-${SN}-3`)?.severity, 'info');
  assert.equal(byId(out, `peer-voldiff-${SN}-3`)?.annunciate, false);
});

test('★★ a lone high outlier among tight siblings: warning; its mirror image below the median: info, muted', () => {
  const high = byId(learned(spreads([12, 13, 14, 15, 60])), `peer-voldiff-${SN}-5`);
  assert.equal(high?.severity, 'warning');
  assert.equal(high?.annunciate, undefined);
  _resetPeerHitCounts();
  const low = byId(learned(spreads([62, 63, 64, 65, 16])), `peer-voldiff-${SN}-5`);
  assert.ok(low, 'still surfaced');
  assert.equal(low!.severity, 'info');
  assert.equal(low!.annunciate, false);
});

test('★★★ SoC and SoH keep the symmetric rule: a LOW SoC and a LOW SoH outlier still warn and annunciate', () => {
  // Scattered siblings so the z-score is real (not the MAD-zero floor that scores exactly Z_INFO).
  const out = learned([
    { vd: 20, soc: 80, soh: 99 }, { vd: 20, soc: 82, soh: 98 }, { vd: 20, soc: 81, soh: 99.5 },
    { vd: 20, soc: 83, soh: 98.5 }, { vd: 20, soc: 40, soh: 90 },
  ]);
  const soc = byId(out, `peer-soc-${SN}-5`);
  assert.ok(soc);
  assert.match(soc!.detail, /lower than/);
  assert.equal(soc!.severity, 'warning', 'a pack far below its siblings\' SoC is a real signal');
  assert.equal(soc!.annunciate, undefined);
  const soh = byId(out, `peer-soh-${SN}-5`);
  assert.ok(soh);
  assert.match(soh!.detail, /lower than/);
  assert.equal(soh!.severity, 'warning');
  assert.equal(soh!.annunciate, undefined);
  assert.equal(byId(out, `peer-voldiff-${SN}-5`), undefined, 'identical spreads: no cell-spread outlier');
});
