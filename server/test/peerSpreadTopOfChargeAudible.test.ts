import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { computeLearnedAlerts, _resetPeerHitCounts } from '../src/analytics.js';
import { conditionFromAlerts, speakableAlerts, IMBALANCE_SPEAK_HOLD_MS } from '../src/broadcast.js';
import { buildAlertMessage } from '../src/ttsService.js';
import { risingEdgePushes, shouldDemoteAnnunciation, shouldSendResolve } from '../src/alertMonitor.js';
import { topOfChargeQuietSpread, vdiffCritMvFor, VOL_DIFF_PLATEAU_QUIET_SOC_PCT, VOL_DIFF_PLATEAU_CRIT_MV } from '../src/cellSpread.js';
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
 * The gate is that predicate on the OUTLIER pack's own SoC and spread. It removes the audible
 * only: v1.45.0 quieted vdiff-warn on the premise that the peer engine still tracks a diverging
 * pack, so the card and the PUSH stay. The gate lifts below the quiet line, or at the critical
 * line — where, while vdiff-crit is held by a bounded mute, alertMonitor's stamp keeps it quiet
 * (peerSpreadYieldsToHeldCritical.test.ts).
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
  assert.match(a!.detail, /At top of charge: not announced on the speakers\./);
});

test('★★★ the push is kept: the gate never sets annunciate:false, and no push gate reads audible', () => {
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
  assert.equal(conditionFromAlerts([{ ...a, audible: undefined }]).level, 'yellow', 'the same alert without the gate speaks');
});

test('★★★ the broadcast tick drops audible:false before the condition AND the spoken message', () => {
  const quiet = peerSpread(KNEE_0929)!;
  // Another warning raises yellow at the same time. It carries no location, so if the quiet
  // outlier (Core 1 Pack 1, Battery) reached the spoken array it would be the one voiced.
  const other: Alert = {
    id: 'ems-volt-DPU-OTHER', severity: 'warning', category: 'Battery', device: 'Core 2',
    title: 'Battery voltage out of range', detail: 'Core 2 battery voltage outside the allowed range.',
  };
  const now = Date.parse('2026-09-29T15:20:00-07:00');
  const onsetOf = () => now - IMBALANCE_SPEAK_HOLD_MS - 60_000; // both past any speak hold
  const spoken = speakableAlerts([other, quiet], now, onsetOf);
  assert.deepEqual(spoken.map((a) => a.id), [other.id], 'the array that feeds both consumers excludes it');
  assert.equal(conditionFromAlerts(spoken).level, 'yellow', 'the other warning still raises yellow');
  const said = buildAlertMessage('yellow', spoken);
  assert.match(said, /voltage/i, 'the other warning is the one voiced');
  assert.doesNotMatch(said, /pack one|spread/i, 'the quiet outlier is never named');
  // And the voiced-primary choice refuses it on its own, for any caller that skips the tick.
  assert.doesNotMatch(buildAlertMessage('yellow', [other, quiet]), /pack one|spread/i);
  // Control: the same outlier WITHOUT the gate is the one voiced (it has the location).
  assert.match(buildAlertMessage('yellow', speakableAlerts([other, { ...quiet, audible: undefined }], now, onsetOf)), /pack one/i);
});

test('★★ below the quiet line the outlier speaks as before (after its 10-minute hold)', () => {
  const a = peerSpread(KNEE_0929.map((p, i) => (i === 0 ? { ...p, soc: 94 } : p)));
  assert.ok(a);
  assert.equal(a!.audible, undefined);
});

test('★★ the gate reads the OUTLIER pack, never a sibling on the knee', () => {
  // Siblings at 99-100% do not quiet a pack at 80%.
  const a = peerSpread(KNEE_0929.map((p, i) => (i === 0 ? { ...p, soc: 80 } : p)));
  assert.ok(a);
  assert.equal(a!.audible, undefined);
});

test('★★★ at the critical line this gate lifts, even at top of charge', () => {
  // From here the pack's own vdiff-crit decides: while a bounded mute holds it, alertMonitor's
  // stamp keeps this outlier quiet too (peerSpreadYieldsToHeldCritical.test.ts); when it speaks,
  // so does this.
  const a = peerSpread(KNEE_0929.map((p, i) => (i === 0 ? { ...p, vd: VOL_DIFF_PLATEAU_CRIT_MV } : p)));
  assert.ok(a);
  assert.equal(a!.audible, undefined, 'a genuinely large spread is never quieted by the top-of-charge gate');
});

test('★ an unknown pack SoC falls back to the Core SoC (as vdiff does); both unknown → speaks', () => {
  const fallback = peerSpread(KNEE_0929.map((p) => ({ ...p, soc: null })), 99);
  assert.equal(fallback!.audible, false);
  _resetPeerHitCounts();
  const unknown = peerSpread(KNEE_0929.map((p) => ({ ...p, soc: null })), null);
  assert.equal(unknown!.audible, undefined, 'never quiet on a reading that is not there');
});

test('★★ only the cell-spread metric is gated', () => {
  // A pack at 99% whose SoH (85%) is a peer outlier: its value is under 90, so a gate that
  // forgot the metric scope would quiet it as if it were a cell spread.
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

test('topOfChargeQuietSpread is v1.45.0 plateauQuietWarn, on one definition', () => {
  assert.equal(VOL_DIFF_PLATEAU_QUIET_SOC_PCT, 95);
  assert.equal(topOfChargeQuietSpread(95, 89), true);
  assert.equal(topOfChargeQuietSpread(94, 30), false);
  assert.equal(topOfChargeQuietSpread(100, 90), false);
  assert.equal(topOfChargeQuietSpread(null, 30), false);
  assert.equal(vdiffCritMvFor(84), 50);
  assert.equal(vdiffCritMvFor(85), 90);
  assert.equal(vdiffCritMvFor(null), 50, 'an unknown SoC takes the stricter line');
});
