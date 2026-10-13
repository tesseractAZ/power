import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { computeLearnedAlerts, _resetPeerHitCounts } from '../src/analytics.js';
import { conditionFromAlerts, speakableAlerts, IMBALANCE_SPEAK_HOLD_MS } from '../src/broadcast.js';
import { buildAlertMessage } from '../src/ttsService.js';
import { risingEdgePushes, shouldDemoteAnnunciation, shouldSendResolve } from '../src/alertMonitor.js';
import { vdiffCritMvFor, VOL_DIFF_PLATEAU_QUIET_SOC_PCT, VOL_DIFF_PLATEAU_CRIT_MV } from '../src/cellSpread.js';
import type { Alert } from '../src/alerts.js';
import type { DeviceSnapshot } from '../src/snapshot.js';

/* ===================================================================
 * v1.187.0 — the peer cell-spread outlier gets a top-of-charge gate (alarm-storm-2).
 *
 * 2026-09-29 15:06-15:27: packs enter the LFP knee one at a time, so whichever gets there
 * first is a peer "outlier" at a 14 mV deviation. peer-voldiff for Core 5 pack 1 (28 mV vs
 * 12-16) and Core 1 pack 1 (39 mV vs 12-19), both at 99% and charging, spoke four yellows and
 * an all-clear — the only family speaking — while the same packs' own vdiff-warn was quiet
 * under v1.45.0's plateauQuietWarn.
 *
 * The gate removed the audible only: v1.45.0 quieted vdiff-warn on the premise that the peer
 * engine still tracks a diverging pack, so the card and the PUSH stay.
 *
 * v1.187.21 — the gate is gone because its window is now the whole range: a cell-spread outlier
 * at WARNING is audible:false at any SoC (2026-10-12 18:31:59, a yellow spoken for one on an
 * evening discharge at 64% — peerSpreadPushedNotAnnounced.test.ts). The 09-29 knee keeps its
 * tests here (still a pushed card, still never spoken). Three tests asserted that the outlier
 * SPEAKS outside the gate — below the 95% line, with a sibling (not itself) at the top, and with
 * no SoC at all; each now asserts it does not, deliberately: the v1.187.12 rule for a
 * warning-level cell spread (pushed, not announced) applies to this report of the same signal
 * too. At the critical line the pack's own vdiff-crit is the audible owner.
 * =================================================================== */

const SN = 'DPU-PEER';
type P = { soc: number | null; vd: number };
function core(packs: P[], coreSoc: number | null = 99): Record<string, DeviceSnapshot> {
  return {
    [SN]: {
      sn: SN, deviceName: 'Core 1', online: true, lastUpdated: Date.now(),
      projection: {
        kind: 'dpu', soc: coreSoc,
        packs: packs.map((p, i) => ({
          num: i + 1, soc: p.soc, maxVolDiffMv: p.vd, packSn: `PACK-${i + 1}`,
          temp: 30, maxCellTemp: 30, soh: 100, actSoh: 100,
        })),
      },
    } as unknown as DeviceSnapshot,
  };
}
/** Three consecutive eval cycles (the v0.13.2 emit gate), then the pack-1 cell-spread outlier. */
function peerSpread(packs: P[], coreSoc?: number | null): Alert | undefined {
  let out: Alert[] = [];
  for (let i = 0; i < 3; i++) out = computeLearnedAlerts(core(packs, coreSoc));
  return out.find((a) => a.id === `peer-voldiff-${SN}-1`);
}
/** 2026-09-29 15:10, Core 1: pack 1 at 39 mV against 12-19 mV siblings, all at 99-100%. */
const KNEE_0929: P[] = [{ soc: 99, vd: 39 }, { soc: 99, vd: 12 }, { soc: 99, vd: 15 }, { soc: 100, vd: 17 }, { soc: 99, vd: 19 }];

beforeEach(() => _resetPeerHitCounts());

test('★★★ 09-29 knee: the outlier is still raised as a WARNING card, but audible:false', () => {
  const a = peerSpread(KNEE_0929);
  assert.ok(a, 'the peer engine still tracks the pack');
  assert.equal(a!.severity, 'warning', 'the fixture reproduces the warning that spoke');
  assert.equal(a!.audible, false, 'at top of charge it is not spoken');
  // v1.187.21 — the card says why in the words of the rule (no longer a top-of-charge note).
  assert.match(a!.detail, /Cell-spread warnings are pushed, not announced; a cell imbalance at the critical line is announced\./);
  assert.doesNotMatch(a!.detail, /At top of charge/);
});

test('★★★ the push is kept: the rule never sets annunciate:false, and no push gate reads audible', () => {
  const a = peerSpread(KNEE_0929)!;
  assert.notEqual(a.annunciate, false, 'annunciate:false would drop the push — the v1.45.0 backstop');
  assert.equal(risingEdgePushes(a), true, 'the rising-edge push is owed');
  assert.equal(shouldDemoteAnnunciation(a, []), false, 'a home Core is not demoted for being quiet on the speakers');
  assert.equal(shouldSendResolve({ pushSent: true, notifiedSeverity: 'warning', alert: a }, true, 'warning'), true,
    'and its Resolved push is owed');
});

test('★★★ the audible condition does not count it (no yellow, no all-clear)', () => {
  const a = peerSpread(KNEE_0929)!;
  assert.equal(conditionFromAlerts([a]).level, 'green');
  assert.equal(conditionFromAlerts([{ ...a, audible: undefined }]).level, 'yellow', 'the same alert without the flag speaks');
});

test('★★★ the broadcast tick drops audible:false before the condition AND the spoken message', () => {
  const quiet = peerSpread(KNEE_0929)!;
  // Another warning raises yellow at the same time. It carries no location, so if the quiet
  // outlier (Core 1 Pack 1, Battery) reached the spoken array it would be the one voiced.
  // v1.187.3 — a Core-level warning family: ems-volt, used here before, is info and never voiced.
  const other: Alert = {
    id: 'dpu-imbalance-DPU-OTHER', severity: 'warning', category: 'Battery', device: 'Core 2',
    title: 'Packs out of balance', detail: '18% state-of-charge difference across Core 2 packs.',
  };
  const now = Date.parse('2026-09-29T15:20:00-07:00');
  const onsetOf = () => now - IMBALANCE_SPEAK_HOLD_MS - 60_000; // both past any speak hold
  const spoken = speakableAlerts([other, quiet], now, onsetOf);
  assert.deepEqual(spoken.map((a) => a.id), [other.id], 'the array that feeds both consumers excludes it');
  assert.equal(conditionFromAlerts(spoken).level, 'yellow', 'the other warning still raises yellow');
  const said = buildAlertMessage('yellow', spoken);
  assert.match(said, /out of balance/i, 'the other warning is the one voiced');
  assert.doesNotMatch(said, /pack one|spread/i, 'the quiet outlier is never named');
  // And the voiced-primary choice refuses it on its own, for any caller that skips the tick.
  assert.doesNotMatch(buildAlertMessage('yellow', [other, quiet]), /pack one|spread/i);
  // Control: the same outlier WITHOUT the flag is the one voiced (it has the location).
  assert.match(buildAlertMessage('yellow', speakableAlerts([other, { ...quiet, audible: undefined }], now, onsetOf)), /pack one/i);
});

test('★★ below the quiet line the outlier is quiet too (v1.187.21 — until then it spoke after its 10-minute hold)', () => {
  // Changed deliberately: a warning-level cell spread is pushed, not announced, at any SoC.
  const a = peerSpread(KNEE_0929.map((p, i) => (i === 0 ? { ...p, soc: 94 } : p)));
  assert.ok(a);
  assert.equal(a!.severity, 'warning');
  assert.equal(a!.audible, false);
  assert.notEqual(a!.annunciate, false, 'and still pushed');
});

test('★★ a pack at 80% among siblings at the top is quiet too (v1.187.21 — until then the gate read its SoC and it spoke)', () => {
  // Changed deliberately: no SoC decides it any more — the outlier pack's or a sibling's.
  const a = peerSpread(KNEE_0929.map((p, i) => (i === 0 ? { ...p, soc: 80 } : p)));
  assert.ok(a);
  assert.equal(a!.audible, false);
  assert.notEqual(a!.annunciate, false);
});

test('★★★ at the critical line the outlier stays quiet: the pack\'s own vdiff-crit is the audible owner', () => {
  // v1.187.0 lifted the gate here, and alertMonitor's stamp quieted the outlier only while a
  // bounded mute held vdiff-crit (removed in v1.187.21 with the gate). vdiff-crit at its fixed
  // line is the audible signal for this spread (peerSpreadPushedNotAnnounced.test.ts).
  const a = peerSpread(KNEE_0929.map((p, i) => (i === 0 ? { ...p, vd: VOL_DIFF_PLATEAU_CRIT_MV } : p)));
  assert.ok(a);
  assert.equal(a!.severity, 'warning', 'peer anomalies cap at warning');
  assert.equal(a!.audible, false);
  assert.notEqual(a!.annunciate, false, 'pushed');
});

test('★ no SoC at all: quiet as well (v1.187.21 — until then an unknown SoC kept it audible)', () => {
  // Changed deliberately. The fail-loud rule ("never quiet on a reading that is not there")
  // protected an audible this alert no longer has; its push does not read SoC.
  const fallback = peerSpread(KNEE_0929.map((p) => ({ ...p, soc: null })), 99);
  assert.equal(fallback!.audible, false);
  _resetPeerHitCounts();
  const unknown = peerSpread(KNEE_0929.map((p) => ({ ...p, soc: null })), null);
  assert.equal(unknown!.audible, false);
  assert.notEqual(unknown!.annunciate, false, 'pushed whatever the SoC reads');
});

test('★★ only the cell-spread metric is quiet', () => {
  // A pack at 99% whose SoH (85%) is a peer outlier: a rule that forgot the metric scope would
  // quiet it as if it were a cell spread.
  let out: Alert[] = [];
  const worn = core(KNEE_0929);
  (worn[SN].projection as any).packs[0].actSoh = 85;
  for (let i = 0; i < 3; i++) out = computeLearnedAlerts(worn);
  const s = out.find((a) => a.id === `peer-soh-${SN}-1`);
  assert.ok(s, 'a worn pack at top of charge is still a peer outlier');
  assert.equal(s!.audible, undefined, 'and it is spoken as before');
  _resetPeerHitCounts();
  const hot = core(KNEE_0929);
  (hot[SN].projection as any).packs[0].maxCellTemp = 45;
  for (let i = 0; i < 3; i++) out = computeLearnedAlerts(hot);
  const t = out.find((a) => a.id === `peer-temp-${SN}-1`);
  assert.ok(t, 'a hot pack at top of charge is still a peer outlier');
  assert.equal(t!.audible, undefined);
});

test('the plateau lines the critical reads are unchanged (topOfChargeQuietSpread retired in v1.187.21)', () => {
  assert.equal(VOL_DIFF_PLATEAU_QUIET_SOC_PCT, 95);
  assert.equal(vdiffCritMvFor(84), 50);
  assert.equal(vdiffCritMvFor(85), 90);
  assert.equal(vdiffCritMvFor(null), 50, 'an unknown SoC takes the stricter line');
});
