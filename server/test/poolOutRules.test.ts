import { test } from 'node:test';
import assert from 'node:assert/strict';
import { poolDiagFromRaw } from '../src/ecoflow/poolDiag.js';
import {
  poolSignals, advancePoolOut, emptyPoolOutState, poolOutSeverity, poolOutSensorState, poolOutOrphanHoldReleased, poolOutAlertId,
  poolOutTitle, poolOutFault, poolOutAlertParts, parsePoolOutFile, serializePoolOutFile, poolOutStateJson, poolOutStateFrom, poolOutLatestEnd,
  POOL_OUT_CAP_TOLERANCE_WH, POOL_OUT_WITNESS_RING, POOL_OUT_SKIP_CONVERT_POLLS,
  type PoolOutState, type PoolOutBaseline, type PoolSignals, type PoolObservation, type PoolOutStreak,
} from '../src/poolOut.js';
import {
  synthBody, observe, fold, minutes, at, withReference, withEpisode, healthyBody, lostBody, quietLostBody, quietBody,
  SLOT_WH, FULL_WH, PANEL_SN, MIN, type Body, type SynthOpts, type Folded,
} from './fixtures/poolOutFixtures.js';

/**
 * v1.208.0 — the pool-out tracker's rules, one boundary at a time (poolOut.ts).
 *
 * Only the CAPACITY raises (STRONG: with the percent or the power naming a slot; SLOW: alone). The percent and the power
 * name and shorten; the panel's flags are quoted and nothing more. Every number below is a boundary of SCOPE-1208.
 */

const TZ = 'America/Phoenix';
const REF: PoolOutBaseline = withReference().baseline as PoolOutBaseline;
const sigOf = (body: Body, baseline: PoolOutBaseline | null = REF): PoolSignals => poolSignals(poolDiagFromRaw(body), baseline);
const restart = (s: PoolOutState): PoolOutState => {
  const back = parsePoolOutFile(serializePoolOutFile(new Map([[PANEL_SN, s]])));
  assert.equal(back.rejected, 0);
  return back.panels.get(PANEL_SN) as PoolOutState;
};
const events = (f: Folded): string[] => f.steps.flatMap((s) => s.events.map((e) => e.type));
const raisedAt = (f: Folded): number | null => f.steps.flatMap((s) => s.events).find((e) => e.type === 'raised')?.atMs ?? null;
const clearedAt = (f: Folded): number | null => f.steps.flatMap((s) => s.events).find((e) => e.type === 'cleared')?.atMs ?? null;
const titleOf = (s: PoolOutState): string | null => (s.episode ? poolOutTitle(s.episode.k, s.episode.slots) : null);
/** One observation at a minute (fractions allowed), its body made for that minute. */
const one = (minute: number, make: (seq: number) => Body, extra: Parameters<typeof observe>[2] = {}): PoolObservation =>
  observe(at(minute), make(Math.round(minute * 1000)), extra);
const lost = (o: Partial<SynthOpts> = {}) => (seq: number): Body => lostBody(seq, o);

test('control: the reference is three slots at 92,160 Wh, and the builders make the bodies they claim to', () => {
  assert.deepEqual(REF.roster, [1, 2, 3]);
  assert.equal(REF.poolCapWh, FULL_WH);
  assert.deepEqual(REF.slotCapWh, { 1: SLOT_WH, 2: SLOT_WH, 3: SLOT_WH });
  assert.equal(sigOf(healthyBody(1)).cls, 'IN');
  assert.equal(sigOf(lostBody(1)).cls, 'STRONG');
  assert.equal(sigOf(quietLostBody(1)).cls, 'SLOW');
  assert.equal(sigOf(quietBody(1)).cls, 'IN');
});

/* ───────────────────────────── CAP ───────────────────────────── */

test('★ CAP tolerance: equal within 1,024 Wh; at 1,025 Wh it is not', () => {
  assert.equal(POOL_OUT_CAP_TOLERANCE_WH, 1024);
  assert.equal(sigOf(quietBody(1, { capWh: FULL_WH - 1024 })).cap.v, 'healthy');
  assert.equal(sigOf(quietBody(1, { capWh: FULL_WH + 1024 })).cap.v, 'healthy');
  const under = sigOf(quietBody(1, { capWh: FULL_WH - 1025 })).cap;
  assert.deepEqual([under.v, under.reason], ['unknown', 'not-slot-sized']);
  const over = sigOf(quietBody(1, { capWh: FULL_WH + 1025 })).cap;
  assert.deepEqual([over.v, over.reason], ['unknown', 'over']);
});

test('★ CAP fault: short by one slot within 1,024 Wh either way; at 1,025 Wh it is not slot-sized', () => {
  for (const off of [0, 1024, -1024]) {
    const cap = sigOf(quietBody(1, { capWh: 2 * SLOT_WH + off })).cap;
    assert.deepEqual([cap.v, cap.k, cap.countedWh, cap.expectedWh], ['fault', 1, 2 * SLOT_WH + off, FULL_WH], `off by ${off}`);
    assert.deepEqual(cap.candidates, [[1], [2], [3]], 'on equal Cores any one slot matches: the capacity alone names none');
    assert.equal(cap.named, null);
  }
  for (const off of [1025, -1025]) {
    const cap = sigOf(quietBody(1, { capWh: 2 * SLOT_WH + off })).cap;
    assert.deepEqual([cap.v, cap.reason], ['unknown', 'not-slot-sized'], `off by ${off}`);
  }
  const two = sigOf(quietBody(1, { capWh: SLOT_WH })).cap;
  assert.deepEqual([two.v, two.k], ['fault', 2]);
  assert.deepEqual(two.candidates, [[1, 2], [1, 3], [2, 3]]);
  // Short by EVERY slot is not a set a coherent reading can name (that is the zero-capacity rule, with its own dwell).
  const all = sigOf(quietBody(1, { capWh: 1000 })).cap;
  assert.deepEqual([all.v, all.reason, all.countedWh], ['unknown', 'not-slot-sized', 1000]);
});

test('CAP reads each slot\'s own capacity, and falls back to the reference when the slot reports none', () => {
  // Slot 2 reports no capacity (0, then no key at all) while the pool is one slot short: E still counts it from the
  // reference, and the slot that lost its capacity is the one CAP names.
  for (const fullCap of [0, null]) {
    const s = sigOf(quietBody(1, { capWh: 2 * SLOT_WH, slots: [{ pct: 60, w: 0 }, { pct: 60, w: 0, fullCap }, { pct: 60, w: 0 }] }));
    assert.deepEqual([s.cap.v, s.cap.k, s.cap.expectedWh, s.cap.named, s.cap.why], ['fault', 1, FULL_WH, [2], 'no-capacity']);
    assert.deepEqual(s.named, [2]);
    assert.equal(s.cls, 'SLOW', 'CAP naming a slot itself is not a second signal');
  }
  // With no reference there is nothing to fall back to.
  const none = sigOf(quietBody(1, { capWh: 2 * SLOT_WH, slots: [{ pct: 60, w: 0 }, { pct: 60, w: 0, fullCap: 0 }, { pct: 60, w: 0 }] }), null);
  assert.deepEqual([none.cap.v, none.cap.reason], ['unknown', 'no-slot-capacity']);
});

test('CAP names a slot the panel does not list as connected — and holds when the capacity did not move', () => {
  const out = sigOf(quietBody(1, { capWh: 2 * SLOT_WH, slots: [{ pct: 60, w: 0 }, { pct: 60, w: 0, isConnect: 0 }, { pct: 60, w: 0 }] }));
  assert.deepEqual([out.cap.v, out.cap.named, out.cap.why], ['fault', [2], 'not-connected']);
  assert.equal(out.evidence?.by, 'cap');
  // The same flag at an unchanged capacity is neither healthy nor a fault: HOLD.
  const same = sigOf(quietBody(1, { slots: [{ pct: 60, w: 0 }, { pct: 60, w: 0, isConnect: 0 }, { pct: 60, w: 0 }], capWh: FULL_WH }));
  assert.deepEqual([same.cap.v, same.cap.reason, same.cls], ['unknown', 'listed-mismatch', 'HOLD']);
  // …even when the percent is consistent and every slot carries its share (it must not count as "in").
  const carrying = sigOf(healthyBody(1, { slots: [{ pct: 72, w: -710 }, { pct: 66, w: -637, isConnect: 0 }, { pct: 63, w: -601 }] }));
  assert.deepEqual([carrying.cap.reason, carrying.pct.v, carrying.flow.v, carrying.cls], ['listed-mismatch', 'consistent', 'healthy', 'HOLD']);
  // Two slots flagged while the capacity is one slot short: CAP cannot say which, and names none.
  const two = sigOf(quietBody(1, { capWh: 2 * SLOT_WH, slots: [{ pct: 60, w: 0, isConnect: 0 }, { pct: 60, w: 0, isConnect: 0 }, { pct: 60, w: 0 }] }));
  assert.deepEqual([two.cap.v, two.cap.k, two.cap.named], ['fault', 1, null]);
});

test('CAP on unequal Cores: the smallest set of slots that matches the shortfall', () => {
  // Two packs, two packs, four packs. Losing the four-pack slot is 24,576 Wh: slot 3 alone, or slots 1 and 2 together.
  const slots = [{ pct: 60, w: 0, fullCap: 12288 }, { pct: 60, w: 0, fullCap: 12288 }, { pct: 60, w: 0, fullCap: 24576 }];
  const ref = fold(emptyPoolOutState(), minutes(-15, 15, (seq) => synthBody({ seq, slots, poolPct: 60 }))).state.baseline as PoolOutBaseline;
  assert.equal(ref.poolCapWh, 49152);
  const cap = sigOf(synthBody({ seq: 1, slots, poolPct: 60, capWh: 24576 }), ref).cap;
  assert.deepEqual([cap.v, cap.k, cap.candidates], ['fault', 1, [[3]]]);
  const small = sigOf(synthBody({ seq: 1, slots, poolPct: 60, capWh: 49152 - 12288 }), ref).cap;
  assert.deepEqual([small.v, small.k, small.candidates], ['fault', 1, [[1], [2]]]);
});

/* ───────────────────────────── PCT ───────────────────────────── */

const pctBody = (pcts: number[], poolPct: number, capWh: number = FULL_WH): Body =>
  synthBody({ seq: 1, capWh, poolPct, slots: pcts.map((pct) => ({ pct, w: 0 })) });

test('★ PCT consistent: within 0.75 of the mean of all slots; 0.76 is not', () => {
  assert.equal(sigOf(pctBody([60, 60, 60], 60.75)).pct.v, 'consistent');
  assert.equal(sigOf(pctBody([60, 60, 60], 59.25)).pct.v, 'consistent');
  assert.equal(sigOf(pctBody([60, 60, 60], 60.76)).pct.v, 'unknown');
  assert.equal(sigOf(pctBody([60, 60, 60], 59.24)).pct.v, 'unknown');
});

test('★ PCT fault needs the pool MORE than 1.5 from the mean of all: 1.5 is not, 1.51 is', () => {
  // Slots 70 / 64 / 64: the mean of all is 66, the mean without slot 1 is 64.
  assert.equal(sigOf(pctBody([70, 64, 64], 64.5)).pct.v, 'unknown', 'exactly 1.5 apart');
  const f = sigOf(pctBody([70, 64, 64], 64.49)).pct;
  assert.deepEqual([f.v, f.set], ['fault', [1]], '1.51 apart, and 0.49 from the mean of slots 2 and 3');
});

test('★ PCT names the set whose absence the pool matches within 0.75; 0.76 does not match', () => {
  // The night of the loss: slots 72 / 65 / 63, the capacity one slot short. The mean of slots 2 and 3 is 64.
  assert.deepEqual(sigOf(pctBody([72, 65, 63], 64.75, 2 * SLOT_WH)).pct.set, [1]);
  assert.deepEqual(sigOf(pctBody([72, 65, 63], 63.25, 2 * SLOT_WH)).pct.set, [1]);
  assert.equal(sigOf(pctBody([72, 65, 63], 64.76, 2 * SLOT_WH)).pct.v, 'unknown');
  assert.equal(sigOf(pctBody([72, 65, 63], 63.24, 2 * SLOT_WH)).pct.v, 'unknown');
});

test('★ PCT takes the count from CAP: without it, the fast-charge reading of 11-16 07:50Z names two slots', () => {
  // Pool 40, slots 99 / 39.5 / 38.5 (slot 1 out, the others charging at 7 kW). The pool is 1.0 from the mean of slots
  // 2 and 3 — no match for one slot — and 0.5 from slot 2 alone, which reads as "slots 1 and 3 out".
  const withCount = sigOf(pctBody([99, 39.5, 38.5], 40, 2 * SLOT_WH));
  assert.equal(withCount.cap.k, 1);
  assert.equal(withCount.pct.v, 'unknown', 'with CAP saying one slot, the percent names nobody');
  const without = sigOf(pctBody([99, 39.5, 38.5], 40, FULL_WH));
  assert.deepEqual([without.cap.v, without.pct.v, without.pct.set], ['healthy', 'fault', [1, 3]], 'the smallest size that matches, when CAP gives no count');
});

test('PCT unknown: two sets match, a slot percent is missing, or fewer than two slots', () => {
  // Slots 70 / 70 / 60 and pool 65: the mean without slot 1 and the mean without slot 2 both match.
  assert.equal(sigOf(pctBody([70, 70, 60], 65)).pct.v, 'unknown');
  assert.equal(sigOf(synthBody({ seq: 1, poolPct: 64, slots: [{ pct: 72 }, { pct: null }, { pct: 63 }] })).pct.v, 'unknown');
  const oneSlot = fold(emptyPoolOutState(), minutes(-15, 15, (seq) => synthBody({ seq, slots: [{}, { isConnect: 0, fullCap: 0 }, { isConnect: 0, fullCap: 0 }], poolPct: 60 }))).state.baseline as PoolOutBaseline;
  assert.deepEqual(oneSlot.roster, [1]);
  assert.equal(sigOf(synthBody({ seq: 1, slots: [{}, { isConnect: 0, fullCap: 0 }, { isConnect: 0, fullCap: 0 }], poolPct: 60 }), oneSlot).pct.v, 'unknown');
});

test('PCT separable: the slots whose absence the pool percent would show', () => {
  // Slots 72 / 65 / 63, pool 67 (the mean of all is 66.67). Without slot 1 the mean is 64 (3.0 away), without slot 2
  // 67.5 (0.5 away), without slot 3 68.5 (1.5 away: not more than 1.5).
  const p = sigOf(pctBody([72, 65, 63], 67)).pct;
  assert.deepEqual([p.v, p.separable], ['consistent', [1]]);
  assert.deepEqual(sigOf(pctBody([60, 60, 60], 60)).pct.separable, [], 'slots at one percent: the pool percent vouches for none');
});

test('PCT weighs each slot by its capacity (the panel\'s percent is remaining over full)', () => {
  // Five packs, five packs, two packs at 80 / 80 / 20: the capacity-weighted mean is 70, the plain mean 60.
  const slots = [{ pct: 80, w: 0 }, { pct: 80, w: 0 }, { pct: 20, w: 0, fullCap: 12288 }];
  assert.equal(sigOf(synthBody({ seq: 1, slots, poolPct: 70 }), null).pct.v, 'consistent');
  assert.equal(sigOf(synthBody({ seq: 1, slots, poolPct: 60 }), null).pct.v, 'unknown');
});

/* ───────────────────────────── FLOW ───────────────────────────── */

const flowBody = (w: Array<number | null>, o: Partial<SynthOpts> = {}, pcts = [66, 66, 66]): Body =>
  synthBody({ seq: 1, poolPct: 66, slots: w.map((x, i) => ({ pct: pcts[i], w: x })), ...o });

test('★ FLOW share: a slot delivering 0.2 of its expected share is healthy; under 0.2 it carries none', () => {
  // Equal headroom, so each slot's expected share is a third of the total. 100 of 500 W is exactly 0.2.
  const ok = sigOf(flowBody([-100, -700, -700])).flow;
  assert.equal(ok.totalW, 1500);
  assert.deepEqual(ok.slots.map((s) => [s.slot, Math.round(s.expectedW), s.v]), [[1, 500, 'healthy'], [2, 500, 'healthy'], [3, 500, 'healthy']]);
  assert.equal(ok.v, 'healthy');
  const low = sigOf(flowBody([-99, -700, -700])).flow;
  assert.deepEqual([low.v, low.set], ['fault', [1]]);
});

test('★ FLOW judges a slot only from an expected share of 150 W; at 149 W it is not judged', () => {
  const judged = sigOf(flowBody([0, -225, -225])).flow;
  assert.equal(judged.slots[0].expectedW, 150);
  assert.deepEqual([judged.v, judged.set], ['fault', [1]]);
  const not = sigOf(flowBody([0, -224, -223])).flow;
  assert.equal(not.slots[0].expectedW, 149);
  assert.deepEqual([not.v, not.set, not.slots.map((s) => s.v)], ['partial', [], ['unjudged', 'unjudged', 'unjudged']]);
});

test('★ FLOW judges only from a total discharge of 300 W; at 299 W nothing is judged', () => {
  // Headroom 80 / 10 / 10 above a 16 % reserve: slot 1 is expected to carry 0.8 of the total.
  const pcts = [96, 26, 26];
  const judged = sigOf(flowBody([0, -150, -150], {}, pcts)).flow;
  assert.equal(judged.totalW, 300);
  assert.deepEqual([judged.v, judged.set], ['fault', [1]]);
  const idle = sigOf(flowBody([0, -150, -149], {}, pcts)).flow;
  assert.deepEqual([idle.v, idle.reason, idle.totalW], ['unknown', 'idle', 299]);
});

test('★ FLOW is unknown while any slot charges: more than 50 W on its channel or on its AC input; 50 W is not charging', () => {
  assert.equal(sigOf(flowBody([-700, -700, 50])).flow.v, 'fault', '50 W in is not charging: the slot is judged (and carries none)');
  assert.deepEqual([sigOf(flowBody([-700, -700, 51])).flow.v, sigOf(flowBody([-700, -700, 51])).flow.reason], ['unknown', 'charging']);
  const input = (inW: number): Body => synthBody({ seq: 1, poolPct: 66, slots: [{ pct: 66, w: -700 }, { pct: 66, w: -700 }, { pct: 66, w: -700, inW }] });
  assert.equal(sigOf(input(50)).flow.v, 'healthy');
  assert.deepEqual([sigOf(input(51)).flow.v, sigOf(input(51)).flow.reason], ['unknown', 'charging']);
});

test('FLOW unknown: a reading it needs is missing, or no slot is above the reserve', () => {
  assert.equal(sigOf(flowBody([-700, null, -700])).flow.reason, 'missing');
  assert.equal(sigOf(flowBody([-700, -700, -700], { reserve: null })).flow.reason, 'missing');
  assert.equal(sigOf(synthBody({ seq: 1, slots: [{ w: -700 }, { w: -700, inW: null }, { w: -700 }] })).flow.reason, 'missing');
  assert.equal(sigOf(synthBody({ seq: 1, slots: [{ w: -700 }, { w: -700, pct: null }, { w: -700 }], poolPct: 60 })).flow.reason, 'missing');
  assert.equal(sigOf(flowBody([-700, -700, -700], { set: { 'backupInfo.chWatt': undefined } })).flow.reason, 'missing');
  assert.equal(sigOf(flowBody([-700, -700, -700], { reserve: 66 })).flow.reason, 'no-headroom');
  assert.equal(sigOf(flowBody([-700, -700, -700], { reserve: 70 })).flow.reason, 'no-headroom');
});

/* ───────────────────────────── FLAG: quoted, nothing more ───────────────────────────── */

const flagged = { ctrlSta: 'BACKUP_CH_STANDBY', backupIsReady: false };

test('★ FLAG never names a slot and never shortens a dwell: with the capacity short it is SLOW, with no slot named', () => {
  // Slot 2's flags differ from its reference and from both other slots; nothing else singles a slot out.
  const s = sigOf(quietLostBody(1, { slots: [{ pct: 60, w: 0 }, { pct: 60, w: 0, ...flagged }, { pct: 60, w: 0 }] }));
  assert.equal(s.flag.v, 'fault');
  assert.deepEqual(s.flag.items.map((i) => [i.slot, i.key, i.value, i.others, i.earlier]), [
    [2, 'ch2Info.backupIsReady', 'false', ['true'], 'true'],
    [2, 'ch2Info.ctrlSta', 'BACKUP_CH_STANDBY', ['BACKUP_CH_DISCHARGE'], 'BACKUP_CH_DISCHARGE'],
  ]);
  assert.equal(s.cls, 'SLOW');
  assert.equal(s.named, null);
  // Fifteen minutes of it raise on the capacity, at the capacity-alone dwell, and the title names no slot.
  const f = fold(withReference(), minutes(0, 16, (seq) => quietLostBody(seq, { slots: [{ pct: 60, w: 0 }, { pct: 60, w: 0, ...flagged }, { pct: 60, w: 0 }] })));
  assert.equal(raisedAt(f), at(15), 'not at the 10-minute dwell');
  assert.equal(titleOf(f.state), 'Core out of the backup pool: slot not identified');
  assert.equal(f.state.streak, null);
});

test('★ FLAG alone is no fault class: with the capacity healthy the observation is IN', () => {
  const s = sigOf(healthyBody(1, { slots: [{ pct: 72, w: -710 }, { pct: 66, w: -637, ...flagged, errorCodeNum: 533 }, { pct: 63, w: -601 }] }));
  assert.equal(s.flag.v, 'fault');
  assert.deepEqual(s.flag.codes, [{ slot: 2, code: 533 }]);
  assert.equal(s.cls, 'IN');
});

test('FLAG votes only when a value differs from its reference AND from every other slot; either alone is only listed', () => {
  // All three slots moved together (a charge): each differs from its reference, none from the others.
  const together = sigOf(quietBody(1, { slots: [0, 1, 2].map(() => ({ pct: 60, w: 0, ctrlSta: 'BACKUP_CH_CHARGE' })) }));
  assert.equal(together.flag.v, 'unknown');
  assert.deepEqual(together.flag.items.map((i) => [i.slot, i.others, i.earlier]), [[1, null, 'BACKUP_CH_DISCHARGE'], [2, null, 'BACKUP_CH_DISCHARGE'], [3, null, 'BACKUP_CH_DISCHARGE']]);
  // No reference: a slot that differs from the others is listed, and is no vote.
  const alone = sigOf(quietBody(1, { slots: [{ pct: 60, w: 0, isAcOpen: 0 }, { pct: 60, w: 0 }, { pct: 60, w: 0 }] }), null);
  assert.equal(alone.flag.v, 'unknown');
  assert.deepEqual(alone.flag.items.map((i) => [i.slot, i.key, i.value, i.others, i.earlier]), [[1, 'isAcOpen', '0', ['1'], null]]);
  // An enum sent as an integer outside the table is compared and listed as "value N".
  const odd = sigOf(quietBody(1, { slots: [{ pct: 60, w: 0, ctrlSta: 7 }, { pct: 60, w: 0 }, { pct: 60, w: 0 }] }));
  assert.deepEqual(odd.flag.items.map((i) => [i.key, i.value]), [['ch1Info.ctrlSta', 'value 7']]);
});

/* ───────────────────────────── classes and naming ───────────────────────────── */

test('the five classes', () => {
  // STRONG by the percent alone (nothing discharging) and by the power alone (slots at one percent).
  const byPct = sigOf(pctBody([72, 65, 63], 64, 2 * SLOT_WH));
  assert.deepEqual([byPct.cls, byPct.pct.v, byPct.flow.v, byPct.named], ['STRONG', 'fault', 'unknown', [1]]);
  const byFlow = sigOf(synthBody({ seq: 1, capWh: 2 * SLOT_WH, poolPct: 60, slots: [{ pct: 60, w: 0 }, { pct: 60, w: -900 }, { pct: 60, w: -900 }] }));
  assert.deepEqual([byFlow.cls, byFlow.pct.v, byFlow.flow.v, byFlow.named], ['STRONG', 'consistent', 'fault', [1]]);
  assert.equal(byFlow.evidence?.by, 'flow');
  assert.equal(sigOf(quietLostBody(1)).cls, 'SLOW');
  // NOCAP: the capacity cannot be compared (here: above the reference), percent and power agree on slot 1.
  const nocap = sigOf(lostBody(1, { capWh: FULL_WH + 5000 }));
  assert.deepEqual([nocap.cap.v, nocap.cls, nocap.pct.set, nocap.flow.set, nocap.named], ['unknown', 'NOCAP', [1], [1], null]);
  assert.equal(sigOf(healthyBody(1)).cls, 'IN');
  // IN without the capacity: percent consistent and every slot carrying its share.
  assert.equal(sigOf(healthyBody(1, { capWh: FULL_WH + 5000 })).cls, 'IN');
  // HOLD: capacity short while every slot carries its share (a contradiction)…
  const contradiction = sigOf(healthyBody(1, { capWh: 2 * SLOT_WH }));
  assert.deepEqual([contradiction.cap.v, contradiction.flow.v, contradiction.cls], ['fault', 'healthy', 'HOLD']);
  // …and capacity unknown with nothing conclusive.
  assert.equal(sigOf(quietBody(1, { capWh: FULL_WH + 5000 })).cls, 'HOLD');
});

test('★ the named set: the namers must agree, on exactly the count CAP gives, and the percent alone does not name a slot seen carrying', () => {
  // Percent and power agree on slot 1.
  assert.deepEqual(sigOf(lostBody(1)).named, [1]);
  // The percent says slot 1, the power says slot 2: STRONG, count only.
  const split = sigOf(synthBody({ seq: 1, capWh: 2 * SLOT_WH, poolPct: 64, slots: [{ pct: 72, w: -800 }, { pct: 65, w: 0 }, { pct: 63, w: -800 }] }));
  assert.deepEqual([split.cls, split.pct.set, split.flow.set, split.named], ['STRONG', [1], [2], null]);
  // Two slots short, the power names one: not the count.
  const short2 = sigOf(synthBody({ seq: 1, capWh: SLOT_WH, poolPct: 60, slots: [{ pct: 60, w: 0 }, { pct: 60, w: -900 }, { pct: 60, w: -900 }] }));
  assert.deepEqual([short2.cls, short2.cap.k, short2.flow.set, short2.named], ['STRONG', 2, [1], null]);
  // The percent names slot 1 while slot 1 is seen carrying its share.
  const carrying = sigOf(synthBody({ seq: 1, capWh: 2 * SLOT_WH, poolPct: 64, slots: [{ pct: 72, w: -800 }, { pct: 65, w: -700 }, { pct: 63, w: -680 }] }));
  assert.deepEqual([carrying.cls, carrying.pct.set, carrying.flow.v, carrying.named], ['STRONG', [1], 'healthy', null]);
  // CAP's own evidence against the power: no name.
  const own = sigOf(synthBody({ seq: 1, capWh: 2 * SLOT_WH, poolPct: 60, slots: [{ pct: 60, w: 0 }, { pct: 60, w: -900, isConnect: 0 }, { pct: 60, w: -900 }] }));
  assert.deepEqual([own.cap.named, own.flow.set, own.named], [[2], [1], null]);
  // CAP's own evidence against the percent, with nothing discharging (so no slot is seen carrying): still no name.
  const ownPct = sigOf(synthBody({ seq: 1, capWh: 2 * SLOT_WH, poolPct: 64, slots: [{ pct: 72, w: 0 }, { pct: 65, w: 0, isConnect: 0 }, { pct: 63, w: 0 }] }));
  assert.deepEqual([ownPct.cls, ownPct.cap.named, ownPct.pct.set, ownPct.flow.v, ownPct.named], ['STRONG', [2], [1], 'unknown', null]);
});

/* ───────────────────────────── the dwell ───────────────────────────── */

test('★ STRONG dwell: 6 observations spanning 10 minutes — 5 are not enough, and 9:59 is not enough', () => {
  // Six a minute apart span five minutes.
  const six = fold(withReference(), minutes(0, 6, lostBody));
  assert.equal(six.state.episode, null);
  assert.deepEqual([six.state.streak?.strong, six.state.streak?.counted], [6, 6]);
  // Five spanning twelve minutes; the sixth raises.
  const five = fold(withReference(), [0, 3, 6, 9, 12].map((m) => one(m, lostBody)));
  assert.equal(five.state.episode, null);
  assert.equal(five.state.streak?.strong, 5);
  assert.equal(raisedAt(fold(five.state, [one(13, lostBody)])), at(13));
  // Six spanning 9:59 do not raise; six spanning 10:00 do.
  const base = fold(withReference(), [0, 2, 4, 6, 8].map((m) => one(m, lostBody))).state;
  const short = fold(base, [one(9 + 59 / 60, lostBody)]);
  assert.equal(short.state.episode, null);
  assert.equal(short.state.streak?.strong, 6);
  const exact = fold(base, [one(10, lostBody)]);
  assert.equal(raisedAt(exact), at(10));
  assert.deepEqual([exact.state.episode?.how, exact.state.episode?.k, exact.state.episode?.slots, exact.state.episode?.sinceMs], ['strong', 1, [1], at(0)]);
});

test('★★ the 10-minute dwell is measured over the STRONG readings themselves, not over the whole streak', () => {
  // Nine capacity-only minutes, then six STRONG readings: at minute 14 the streak spans fourteen minutes and holds six
  // STRONG readings, but those six span five. No raise there; the capacity dwell raises at minute 15.
  const f = fold(withReference(), [...minutes(0, 9, quietLostBody), ...minutes(9, 7, lostBody)]);
  assert.deepEqual([f.steps[14].state.streak?.strong, f.steps[14].state.streak?.counted], [6, 15]);
  assert.equal(f.steps[14].state.episode, null, 'minute 14: six STRONG readings span five minutes');
  assert.equal(raisedAt(f), at(15));
  assert.equal(f.state.episode?.how, 'slow');
});

test('★ at one reading a minute the alarm raises at the eleventh reading: 10 minutes after the first', () => {
  const f = fold(withReference(), minutes(0, 12, lostBody));
  assert.equal(raisedAt(f), at(10));
  assert.deepEqual(events(f), ['first-fault', 'raised']);
  assert.equal(f.steps[9].state.episode, null, 'not present at minute 9');
  assert.equal(titleOf(f.steps[10].state), 'Core out of the backup pool: slot 1');
});

test('★ capacity alone: 15 observations spanning 15 minutes — 14 are not enough, and 14:59 is not enough', () => {
  // Fourteen spanning twenty minutes; the fifteenth raises.
  const fourteen = fold(withReference(), [...minutes(0, 13, quietLostBody), one(20, quietLostBody)]);
  assert.equal(fourteen.state.episode, null);
  assert.deepEqual([fourteen.state.streak?.counted, fourteen.state.streak?.strong], [14, 0]);
  assert.equal(raisedAt(fold(fourteen.state, [one(21, quietLostBody)])), at(21));
  // Fifteen spanning 14:59 do not raise; fifteen spanning 15:00 do.
  const base = fold(withReference(), minutes(0, 14, quietLostBody)).state;
  assert.equal(fold(base, [one(14 + 59 / 60, quietLostBody)]).state.episode, null);
  const exact = fold(base, [one(15, quietLostBody)]);
  assert.equal(raisedAt(exact), at(15));
  assert.deepEqual([exact.state.episode?.how, exact.state.episode?.k, exact.state.episode?.slots], ['slow', 1, null]);
  // At one reading a minute: the sixteenth reading, 15 minutes after the first.
  assert.equal(raisedAt(fold(withReference(), minutes(0, 20, quietLostBody))), at(15));
});

test('★ a streak whose readings name different slots raises with the count only', () => {
  // Three readings in which the power points at slot 1, then eight in which it points at slot 2.
  const power = (out: number) => (seq: number): Body => synthBody({ seq, capWh: 2 * SLOT_WH, poolPct: 60, slots: [1, 2, 3].map((n) => ({ pct: 60, w: n === out ? 0 : -900 })) });
  const f = fold(withReference(), [...minutes(0, 3, power(1)), ...minutes(3, 8, power(2))]);
  assert.deepEqual([f.steps[0].signals?.named, f.steps[3].signals?.named], [[1], [2]]);
  assert.equal(raisedAt(f), at(10));
  assert.deepEqual([f.state.episode?.k, f.state.episode?.slots, f.state.episode?.evidence], [1, null, null]);
  assert.equal(titleOf(f.state), 'Core out of the backup pool: slot not identified');
  // The disagreement is not forgotten at the raise: the later name does not ride on the readings from before it. Slot 2
  // is named once the readings AFTER the raise have named it for ten minutes (minutes 11 to 21).
  assert.equal(f.state.episode?.change, null, 'nothing is carried from a streak whose readings disagreed');
  const on = fold(f.state, minutes(11, 11, power(2)));
  assert.equal(titleOf(on.steps[9].state), 'Core out of the backup pool: slot not identified', 'minute 20');
  assert.equal(titleOf(on.steps[10].state), 'Core out of the backup pool: slot 2', 'minute 21');
});

test('the capacity-alone dwell counts every raising class: five STRONG and ten SLOW raise at 15 minutes', () => {
  const f = fold(withReference(), [...minutes(0, 5, lostBody), ...minutes(5, 12, quietLostBody)]);
  assert.equal(raisedAt(f), at(15));
  assert.equal(f.state.episode?.how, 'slow');
  // Five readings over four minutes named slot 1: that is not a dwell of naming readings, and the title names none.
  assert.equal(f.state.episode?.slots, null);
});

/* ───────────────────────────── what a raise latches ───────────────────────────── */

/** Two Cores short: slots 1 and 3 carry nothing, and the pool percent is slot 2's. */
const twoShort = (seq: number): Body => synthBody({ seq, capWh: SLOT_WH, poolPct: 65, slots: [{ pct: 72, w: 0 }, { pct: 65, w: -2100 }, { pct: 40, w: 0 }] });
/** Two Cores short with nothing else to go by. */
const quietTwoShort = (seq: number): Body => quietLostBody(seq, { capWh: SLOT_WH });
const sevAt = (f: Folded, i: number): string | null => poolOutSeverity(f.steps[i].state);

test('★★★ the count and the severity at a raise are never those of the ONE reading that completes the dwell (strong)', () => {
  // Ten readings one Core short; the eleventh, which completes the ten minutes, is ONE reading two Cores short; then
  // one Core short again. On 07-02 and 08-20 the capacity read 30.7 kWh for a while with no Core leaving.
  const f = fold(withReference(), [...minutes(0, 10, lostBody), one(10, twoShort), ...minutes(11, 20, lostBody)]);
  assert.equal(f.steps[10].signals?.cap.k, 2, 'control: the completing reading is two slots short');
  assert.equal(raisedAt(f), at(10), 'it still counts toward the dwell: the pool is at least one slot short');
  assert.deepEqual([f.steps[10].state.episode?.k, f.steps[10].state.episode?.countedWh, sevAt(f, 10)], [1, 2 * SLOT_WH, 'warning']);
  assert.equal(f.steps.some((s) => poolOutSeverity(s.state) === 'critical'), false, 'never critical on one reading at 30.7 kWh');
  assert.equal(events(f).includes('severity'), false);
  assert.equal(f.state.episode?.k, 1);
  // …wherever in the dwell that one reading falls.
  for (let pos = 0; pos <= 10; pos++) {
    const g = fold(withReference(), Array.from({ length: 13 }, (_, m) => one(m, m === pos ? twoShort : lostBody)));
    assert.equal(raisedAt(g), at(10), `pos ${pos}`);
    assert.equal(g.steps.some((s) => poolOutSeverity(s.state) === 'critical'), false, `pos ${pos}`);
    assert.equal(g.state.episode?.k, 1, `pos ${pos}`);
  }
});

test('★★★ the count and the severity at a raise are never those of the one completing reading (capacity alone)', () => {
  // Fifteen capacity-only minutes one slot short, then ONE reading two slots short completes the fifteen minutes.
  const f = fold(withReference(), [...minutes(0, 15, quietLostBody), one(15, quietTwoShort)]);
  assert.equal(raisedAt(f), at(15));
  assert.deepEqual([titleOf(f.state), poolOutSeverity(f.state), f.state.episode?.countedWh], ['Core out of the backup pool: slot not identified', 'warning', 2 * SLOT_WH]);
  // Hardware work: one slot short for thirteen minutes, then two short for three readings. A warning at 15.
  const work = fold(withReference(), [...minutes(0, 13, quietLostBody), ...minutes(13, 3, quietTwoShort)]);
  assert.equal(raisedAt(work), at(15));
  assert.deepEqual([work.state.episode?.k, poolOutSeverity(work.state)], [1, 'warning']);
  // The two-slot count goes on through a dwell of ITS OWN readings (minutes 13 to 28): critical then, not before.
  const on = fold(work.state, minutes(16, 14, quietTwoShort));
  assert.equal(poolOutSeverity(on.steps[11].state), 'warning', 'minute 27: fifteen readings span fourteen minutes');
  assert.deepEqual([poolOutSeverity(on.steps[12].state), on.steps[12].state.episode?.k, on.steps[12].state.episode?.countedWh], ['critical', 2, SLOT_WH]);
  assert.deepEqual(on.steps[12].events.map((e) => e.type), ['set-changed', 'severity']);
});

test('★★★ a smaller count takes the streak over, and the larger count keeps its own tally', () => {
  // Fifteen minutes TWO slots short, and the reading that completes them is ONE reading one slot short: fifteen readings
  // two short span fourteen minutes, which is not their dwell, so the raise is for one slot.
  const f = fold(withReference(), [...minutes(0, 15, quietTwoShort), one(15, quietLostBody)]);
  assert.equal(raisedAt(f), at(15));
  assert.deepEqual([f.state.episode?.k, poolOutSeverity(f.state), f.state.episode?.countedWh], [1, 'warning', 2 * SLOT_WH]);
  const pending = f.state.episode?.change as PoolOutStreak;
  assert.deepEqual([pending.k, pending.counted, pending.firstMs, pending.lastMs, pending.countedWh], [2, 15, at(0), at(14), SLOT_WH], 'the two-slot tally is kept, not thrown away');
  // ONE more reading two short completes that tally's own fifteen minutes: critical at minute 16, not at minute 31.
  const next = fold(f.state, [one(16, quietTwoShort)]);
  assert.deepEqual([next.state.episode?.k, poolOutSeverity(next.state), next.state.episode?.countedWh], [2, 'critical', SLOT_WH]);
  // Had the two-short readings already met their own dwell, the raise is theirs: sixteen of them, then one one-short.
  const sixteen = fold(withReference(), minutes(0, 16, quietTwoShort));
  assert.deepEqual([raisedAt(sixteen), sixteen.state.episode?.k, poolOutSeverity(sixteen.state)], [at(15), 2, 'critical']);
});

test('★★★ a second Core leaving inside the first dwell: a warning at 10 minutes, critical when ITS readings have their own dwell', () => {
  // Slot 1 out from minute 0; slot 3 follows at minute 6.
  const f = fold(withReference(), [...minutes(0, 6, lostBody), ...minutes(6, 14, twoShort)]);
  assert.equal(raisedAt(f), at(10));
  assert.deepEqual([f.steps[10].state.episode?.k, sevAt(f, 10)], [1, 'warning'], 'at minute 10 the two-slot count is four minutes old');
  assert.equal(sevAt(f, 15), 'warning', 'minute 15: ten readings two short span nine minutes');
  assert.deepEqual([sevAt(f, 16), titleOf(f.steps[16].state), f.steps[16].state.episode?.countedWh], ['critical', '2 Cores out of the backup pool: slots 1 and 3', SLOT_WH]);
  assert.deepEqual(f.steps[16].events.map((e) => e.type), ['set-changed', 'severity']);
});

test('★★ the largest count whose own readings have met a dwell is the one latched', () => {
  // Two short at minutes 0-6, ONE reading one short at minute 7, two short at 8-15. At minute 15 the fifteen readings
  // two short span fifteen minutes: their dwell is met at the same reading as the whole streak's, and the raise is theirs.
  const f = fold(withReference(), Array.from({ length: 16 }, (_, m) => one(m, m === 7 ? quietLostBody : quietTwoShort)));
  assert.equal(raisedAt(f), at(15));
  assert.deepEqual([f.state.episode?.k, poolOutSeverity(f.state), f.state.episode?.countedWh, f.state.episode?.change], [2, 'critical', SLOT_WH, null]);
});

test('★★ a larger count that stops being read is dropped by the 15-minute gap, and never raises the severity', () => {
  const f = fold(withReference(), [...minutes(0, 10, lostBody), one(10, twoShort), ...minutes(11, 15, lostBody)]);
  const pending = f.steps[25].state.episode?.change as PoolOutStreak;
  assert.deepEqual([pending.k, pending.counted, pending.lastMs], [2, 1, at(10)], 'minute 25: its one reading is 15:00 old, and it still waits');
  const over = fold(f.state, [one(26, lostBody)]);
  assert.equal(over.state.episode?.change, null, 'minute 26: over, though this reading says nothing against the latch');
  assert.equal([...f.steps, ...over.steps].some((x) => poolOutSeverity(x.state) === 'critical'), false);
  // Before the raise as well: a streak one short with one reading two short in it, read again 15:01 later.
  const st = fold(withReference(), [...minutes(0, 3, quietLostBody), one(3, quietTwoShort), ...minutes(4, 3, quietLostBody)]).state.streak as PoolOutStreak;
  assert.deepEqual([st.k, st.counted, st.more?.k, st.more?.counted, st.more?.lastMs], [1, 7, 2, 1, at(3)]);
  const again = fold(withReference(), [...minutes(0, 3, quietLostBody), one(3, quietTwoShort), ...minutes(4, 3, quietLostBody), one(18 + 1 / 60, quietTwoShort)]).state.streak as PoolOutStreak;
  assert.deepEqual([again.more?.counted, again.more?.firstMs], [1, at(18 + 1 / 60)], '15:01 after its last reading the larger tally starts again');
  const kept = fold(withReference(), [...minutes(0, 3, quietLostBody), one(3, quietTwoShort), ...minutes(4, 3, quietLostBody), one(18, quietTwoShort)]).state.streak as PoolOutStreak;
  assert.deepEqual([kept.more?.counted, kept.more?.firstMs], [2, at(3)], '15:00 carries it');
});

test('★★★ the slot in the title needs a dwell of readings that name it: six, spanning ten minutes — never one', () => {
  // The pool near its reserve under a modest load: the slot that left is not judged by its power (86 W expected) and
  // the percent cannot single it out. Fifteen minutes of count-only readings, ONE of them with slot 2 at 0 W.
  const near = (w2: number, w3: number) => (seq: number): Body => synthBody({ seq, capWh: 2 * SLOT_WH, reserve: 16, poolPct: 19, slots: [{ pct: 17, w: 0 }, { pct: 19, w: w2 }, { pct: 19, w: w3 }] });
  const f = fold(withReference((seq) => synthBody({ seq, reserve: 16, poolPct: 18, slots: [{ pct: 17, w: -86 }, { pct: 19, w: -257 }, { pct: 19, w: -257 }] })),
    Array.from({ length: 16 }, (_, m) => one(m, m === 7 ? near(0, -600) : near(-300, -300))));
  assert.deepEqual([f.steps[0].signals?.cls, f.steps[0].signals?.named, f.steps[7].signals?.named], ['SLOW', null, [2]], 'control: one reading names slot 2');
  assert.equal(raisedAt(f), at(15));
  assert.equal(titleOf(f.state), 'Core out of the backup pool: slot not identified');
  assert.equal(poolOutFault(f.state.episode!.k, f.state.episode!.slots), 'out:?;k=1');
  // Four hours of count-only readings later the title still names no slot, and no set change was logged.
  const later = fold(f.state, minutes(16, 240, near(-300, -300)));
  assert.equal(titleOf(later.state), 'Core out of the backup pool: slot not identified');
  assert.equal(events(later).includes('set-changed'), false);
  // Five naming readings are not six; six spanning 9:59 are not ten minutes; six spanning 10:00 name the slot at the raise.
  const base = [0, 2, 4, 6, 8].map((m) => one(m, lostBody));
  const count = (extra: PoolObservation[]): Folded => fold(withReference(), [...base, ...extra, ...Array.from({ length: 12 }, (_, i) => one(10.5 + i, quietLostBody))]);
  const five = count([]);
  assert.deepEqual([five.state.episode?.how, five.state.episode?.slots], ['slow', null], 'five naming readings');
  // (the sixth STRONG reading at 9:59 is no strong dwell either: the raise is the capacity dwell's, at minute 15.5)
  const short = count([one(9 + 59 / 60, lostBody)]);
  assert.deepEqual([short.state.episode?.how, short.state.episode?.slots], ['slow', null], 'six naming readings spanning 9:59');
  const exact = fold(withReference(), [...base, one(10, lostBody)]);
  assert.deepEqual([raisedAt(exact), exact.state.episode?.slots], [at(10), [1]], 'six spanning 10:00');
});

test('★★ a set the readings agree on but have not named for a dwell goes on as the pending change, and is latched when they have', () => {
  // Nine minutes of readings naming slot 1, and the completing reading at minute 10 names nothing (it is two short).
  const f = fold(withReference(), [...minutes(0, 10, lostBody), one(10, twoShort)]);
  assert.equal(titleOf(f.state), 'Core out of the backup pool: slot not identified');
  const pending = f.state.episode?.change as PoolOutStreak;
  assert.deepEqual([pending.k, pending.slots, pending.names?.n, pending.names?.firstMs], [1, [1], 10, at(0)]);
  // The next reading naming slot 1 makes eleven over eleven minutes: named, logged as a set change, the same episode.
  const next = fold(f.state, [one(11, lostBody)]);
  assert.equal(titleOf(next.state), 'Core out of the backup pool: slot 1');
  assert.deepEqual(next.steps[0].events, [{ type: 'set-changed', atMs: at(11) }]);
  assert.equal(next.state.episode?.evidence?.by, 'flow');
  assert.equal(next.state.episode?.sinceMs, at(0));
  // Readings naming DIFFERENT slots after a count-only raise establish none: the naming starts again each time.
  const power = (out: number) => (seq: number): Body => synthBody({ seq, capWh: 2 * SLOT_WH, poolPct: 60, slots: [1, 2, 3].map((n) => ({ pct: 60, w: n === out ? 0 : -900 })) });
  const unnamed = fold(withReference(), minutes(0, 16, quietLostBody)).state;
  const mixed = fold(unnamed, Array.from({ length: 40 }, (_, i) => one(16 + i, power(i % 2 === 0 ? 1 : 2))));
  assert.equal(titleOf(mixed.state), 'Core out of the backup pool: slot not identified');
  assert.equal(events(mixed).includes('set-changed'), false);
});

test('★★ a pending DECREASE (a Core back while another is still out) needs its own dwell, and one reading at the latched count ends it', () => {
  const two = fold(withReference(), minutes(0, 11, twoShort)).state;
  assert.deepEqual([titleOf(two), poolOutSeverity(two)], ['2 Cores out of the backup pool: slots 1 and 3', 'critical']);
  // Fourteen one-short readings among two-short ones, one every other minute: each two-short reading ends the pending
  // decrease, so the alarm stays at two Cores and critical. (Readings one short piled up across them before.)
  const sparse = fold(two, Array.from({ length: 40 }, (_, i) => one(11 + i, i % 2 === 0 ? quietLostBody : twoShort)));
  assert.deepEqual([titleOf(sparse.state), poolOutSeverity(sparse.state)], ['2 Cores out of the backup pool: slots 1 and 3', 'critical']);
  assert.equal(events(sparse).includes('set-changed'), false);
  assert.equal(sparse.state.episode?.less, null, 'the last reading was at the latched count');
  // An unbroken dwell of one-short readings is the partial return: one Core out, a warning, the same episode.
  const part = fold(two, minutes(11, 16, quietLostBody));
  assert.equal(part.steps[14].state.episode?.k, 2, 'not before the fifteen minutes');
  assert.deepEqual([part.steps[14].state.episode?.less?.k, part.steps[14].state.episode?.less?.counted], [1, 15]);
  assert.deepEqual([part.state.episode?.k, poolOutSeverity(part.state), part.state.episode?.less, part.state.episode?.change], [1, 'warning', null, null]);
  // A reading MORE slots short than the latch never counts toward a decrease.
  const three = fold(two, [...minutes(11, 14, quietLostBody), one(25, twoShort), one(26, quietLostBody)]);
  assert.deepEqual([three.state.episode?.k, three.state.episode?.less?.counted], [2, 1]);
  // Every slot out (the zero-capacity rule), then readings one short and two short by turns: what a dwell of them
  // supports is "at most two short", so the alarm goes to two Cores — the larger of the counts read — and stays critical.
  const zero = (seq: number): Body => synthBody({ seq, capWh: 0, poolPct: 0, remainWh: 0, slots: [0, 1, 2].map(() => ({ pct: 60, w: 0 })) });
  const all = fold(withReference(), minutes(0, 20, zero)).state;
  assert.equal(titleOf(all), '3 Cores out of the backup pool: slots 1, 2 and 3');
  const mixed = fold(all, Array.from({ length: 16 }, (_, i) => one(20 + i, i % 2 === 0 ? quietLostBody : quietTwoShort)));
  assert.equal(mixed.steps[14].state.episode?.k, 3, 'minute 34: fifteen readings span fourteen minutes');
  assert.deepEqual([mixed.state.episode?.k, titleOf(mixed.state), poolOutSeverity(mixed.state), mixed.state.episode?.countedWh], [2, '2 Cores out of the backup pool: slots not identified', 'critical', SLOT_WH]);
});

/* ── lines the second review found unheld: each survived a probe mutant against every pool-out test file ── */

/** Two slots the panel itself does not list as connected, everything idle: capacity alone, named by the panel's own listing. */
const twoUnlisted = (seq: number): Body => synthBody({ seq, capWh: SLOT_WH, poolPct: 60, slots: [{ pct: 60, w: 0, isConnect: 0 }, { pct: 60, w: 0 }, { pct: 60, w: 0, isConnect: 0 }] });

test('★★ a smaller count that takes the streak over does not inherit the larger count\'s names', () => {
  // Fourteen readings two short, each naming slots 1 and 3 (the panel's own listing); then the capacity reads ONE short.
  const f = fold(withReference(), [...minutes(0, 14, twoUnlisted), ...minutes(14, 2, quietLostBody)]);
  assert.deepEqual([f.steps[13].signals?.cap.k, f.steps[13].signals?.named, f.steps[14].signals?.cap.k, f.steps[14].signals?.named], [2, [1, 3], 1, null], 'control');
  assert.equal(raisedAt(f), at(15), 'control');
  assert.deepEqual([f.state.episode?.k, f.state.episode?.slots], [1, null]);
  assert.equal(titleOf(f.state), 'Core out of the backup pool: slot not identified', 'never "Core out …: slots 1 and 3"');
  assert.equal(poolOutFault(1, f.state.episode!.slots), 'out:?;k=1');
});

test('★★ the naming run starts again when the count moves: one reading at the new count names nothing', () => {
  // Ten readings two short naming slots 1 and 3 (minutes 0 to 9), ONE reading one short naming slot 1 at minute 10,
  // then count-only readings. The run of ten is not slot 1's.
  const f = fold(withReference(), [...minutes(0, 10, twoUnlisted), one(10, lostBody), ...minutes(11, 5, quietLostBody)]);
  assert.deepEqual([f.steps[10].signals?.cap.k, f.steps[10].signals?.named], [1, [1]], 'control');
  assert.equal(raisedAt(f), at(15), 'control');
  assert.deepEqual([f.state.episode?.k, f.state.episode?.slots], [1, null], 'one reading named slot 1');
});

test('★★ a pending decrease is over after 15 minutes without a reading of it, and a reading dated before its last one starts it again', () => {
  const two = fold(withReference(), minutes(0, 16, quietTwoShort)).state;
  assert.deepEqual([two.episode?.k, poolOutSeverity(two)], [2, 'critical'], 'control');
  // Eight readings one short (minutes 16 to 23); twenty minutes of bodies that cannot be used; seven more (44 to 50).
  const torn = (seq: number): Body => quietLostBody(seq, { poolPct: 67, remainWh: Math.round(0.67 * FULL_WH) });
  const f = fold(two, [...minutes(16, 8, quietLostBody), ...minutes(24, 20, torn), ...minutes(44, 7, quietLostBody)]);
  assert.equal(f.steps[8].skip, 'incoherent', 'control: the bodies between are skipped');
  assert.deepEqual([f.state.episode?.k, poolOutSeverity(f.state), f.state.episode?.less?.counted, f.state.episode?.less?.firstMs], [2, 'critical', 7, at(44)],
    'fifteen readings one short, but not within 15 minutes of one another: still two Cores, critical');
  // The host clock stepped back: a reading dated 30 seconds BEFORE the tally's last one does not carry it.
  const back = fold(two, [...minutes(16, 5, quietLostBody), one(19.5, quietLostBody)]);
  assert.deepEqual([back.state.episode?.less?.counted, back.state.episode?.less?.firstMs], [1, at(19.5)]);
});

test('★★ a pending decrease keeps the capacity of the readings AT its count, whichever reading completes its dwell', () => {
  const all = fold(withReference(), minutes(0, 20, zeroBody)).state;
  assert.equal(titleOf(all), '3 Cores out of the backup pool: slots 1, 2 and 3', 'control');
  // Two short and one short by turns, the dwell completed by a reading ONE short: "at most two short", at 30.7 kWh.
  const f = fold(all, Array.from({ length: 16 }, (_, i) => one(20 + i, i % 2 === 0 ? quietTwoShort : quietLostBody)));
  assert.equal(f.steps[15].signals?.cap.k, 1, 'control: the completing reading is one short');
  assert.deepEqual([f.state.episode?.k, f.state.episode?.countedWh, poolOutSeverity(f.state)], [2, SLOT_WH, 'critical']);
});

test('★★ a confirmed decrease ends a pending change with it: the name that was on its way belonged to the larger count', () => {
  const two = fold(withReference(), minutes(0, 16, quietTwoShort)).state;
  const pending = fold(two, [one(16, twoShort)]).state;
  assert.deepEqual([pending.episode?.slots, pending.episode?.change?.k, pending.episode?.change?.slots], [null, 2, [1, 3]], 'control: one reading named slots 1 and 3');
  const part = fold(pending, minutes(17, 16, quietLostBody));
  assert.equal(part.steps[14].state.episode?.k, 2, 'minute 31: fifteen readings one short span fourteen minutes');
  assert.notEqual(part.steps[14].state.episode?.change, null, 'control: the pending name is still on its way then');
  assert.deepEqual([part.state.episode?.k, part.state.episode?.slots, part.state.episode?.change, part.state.episode?.less], [1, null, null, null]);
});

test('★★ readings that disagree inside an episode start the naming again; a slot named for a dwell afterwards is latched', () => {
  const power = (out: number) => (seq: number): Body => synthBody({ seq, capWh: 2 * SLOT_WH, poolPct: 60, slots: [1, 2, 3].map((n) => ({ pct: 60, w: n === out ? 0 : -900 })) });
  const unnamed = fold(withReference(), minutes(0, 16, quietLostBody)).state;
  assert.equal(titleOf(unnamed), 'Core out of the backup pool: slot not identified', 'control');
  const f = fold(unnamed, [one(16, power(1)), one(17, power(2)), ...minutes(18, 11, power(2))]);
  assert.equal(titleOf(f.steps[11].state), 'Core out of the backup pool: slot not identified', 'minute 27: slot 2 is named since minute 17; the reading that disagreed is not counted from');
  assert.equal(titleOf(f.state), 'Core out of the backup pool: slot 2', 'minute 28: named for ten minutes since the disagreement');
});

test('★★ a larger count confirmed inside an episode leaves a STILL larger one on its way: it is not dropped at the set change', () => {
  // Slot 1 out (the alarm stands). From minute 11 the capacity reads two short; from minute 21 it reads zero: four
  // such readings are skipped, and from the fifth (minute 25) they are read as every slot out.
  const f = fold(withEpisode(), [...minutes(11, 10, quietTwoShort), ...minutes(21, 20, zeroBody)]);
  assert.deepEqual([f.steps[13].skip, f.steps[14].converted, f.steps[14].signals?.cap.k], ['zero-capacity', 'all-out', 3], 'control');
  // Minute 29: fifteen readings at least two short span eighteen minutes. Two Cores, and the three-slot tally goes on.
  const at29 = f.steps[18].state.episode;
  assert.deepEqual([at29?.k, at29?.change?.k, at29?.change?.counted, at29?.change?.firstMs], [2, 3, 5, at(25)]);
  assert.equal(f.steps[28].state.episode?.k, 2, 'minute 39: fifteen readings three short span fourteen minutes');
  assert.equal(titleOf(f.state), '3 Cores out of the backup pool: slots 1, 2 and 3', 'minute 40: their own dwell, counted from minute 25 — not from the set change at minute 29');
});

/* ── the name: pending between its readings, and contradicted by the latched one ── */

test('★★ a pending name does not age out between its readings while the capacity stays short at the latched count', () => {
  // The capacity alone raises at minute 15, unnamed. The slot that left is seen only while the pool discharges: two
  // readings in every twenty minutes name slot 1, none names another, and the bursts are 18 minutes apart.
  const f = fold(withReference(), Array.from({ length: 62 }, (_, m) => one(m, m >= 20 && m % 20 < 2 ? lostBody : quietLostBody)));
  assert.equal(raisedAt(f), at(15), 'control');
  assert.deepEqual([f.steps[41].state.episode?.change?.names?.n, f.steps[41].state.episode?.change?.names?.firstMs], [4, at(20)], 'minute 41: the second burst is counted with the first');
  assert.equal(titleOf(f.steps[60].state), 'Core out of the backup pool: slot not identified', 'minute 60: five readings have named slot 1');
  assert.equal(titleOf(f.steps[61].state), 'Core out of the backup pool: slot 1', '★ minute 61: the sixth');
  assert.deepEqual(f.steps[61].events, [{ type: 'set-changed', atMs: at(61) }]);
  // A gap in the readings themselves (an outage of more than 15 minutes) still ends it: the naming starts again.
  const unnamed = fold(withReference(), minutes(0, 16, quietLostBody)).state;
  const gap = fold(unnamed, [...minutes(16, 4, lostBody), ...minutes(36, 4, lostBody)]);
  assert.deepEqual([titleOf(gap.state), gap.state.episode?.change?.names?.n, gap.state.episode?.change?.names?.firstMs], ['Core out of the backup pool: slot not identified', 4, at(36)]);
});

test('★★ readings that name the LATCHED slot end a pending rename: two slots named by turns never flip the title', () => {
  const power = (out: number) => (seq: number): Body => synthBody({ seq, capWh: 2 * SLOT_WH, poolPct: 60, slots: [1, 2, 3].map((n) => ({ pct: 60, w: n === out ? 0 : -900 })) });
  const ep1 = fold(withReference(), minutes(0, 11, power(1))).state;
  assert.equal(titleOf(ep1), 'Core out of the backup pool: slot 1', 'control: latched on slot 1');
  const turns = fold(ep1, Array.from({ length: 60 }, (_, i) => one(11 + i, power(i % 2 === 0 ? 2 : 1))));
  assert.deepEqual([turns.steps[0].signals?.named, turns.steps[1].signals?.named], [[2], [1]], 'control');
  assert.equal(events(turns).includes('set-changed'), false, '★ no set change in an hour of readings naming slot 2 and slot 1 by turns');
  assert.equal(titleOf(turns.state), 'Core out of the backup pool: slot 1');
  // An unbroken dwell of readings naming slot 2 IS a rename (six, spanning ten minutes), as before…
  const moved = fold(ep1, minutes(11, 11, power(2)));
  assert.equal(titleOf(moved.steps[9].state), 'Core out of the backup pool: slot 1', 'minute 20');
  assert.equal(titleOf(moved.state), 'Core out of the backup pool: slot 2', 'minute 21');
  // …and ONE reading naming the latched slot inside it starts that naming again.
  const broken = fold(ep1, [...minutes(11, 9, power(2)), one(20, power(1)), ...minutes(21, 10, power(2))]);
  assert.equal(broken.steps[9].state.episode?.change, null, 'minute 20: the pending rename is over');
  assert.equal(titleOf(broken.state), 'Core out of the backup pool: slot 1', 'minute 30: slot 2 is named since minute 21');
  assert.equal(titleOf(fold(broken.state, [one(31, power(2))]).state), 'Core out of the backup pool: slot 2', 'minute 31');
});

test('★ a gap of 15:00 between counted observations carries the streak; 15:01 starts it again — by data time, across a restart too', () => {
  const three = fold(withReference(), minutes(0, 3, lostBody)).state;
  for (const state of [three, restart(three)]) {
    const carried = fold(state, [one(17, lostBody)]).state.streak;
    assert.deepEqual([carried?.firstMs, carried?.counted], [at(0), 4], 'minute 2 to minute 17 is 15:00');
    const again = fold(state, [one(17 + 1 / 60, lostBody)]).state.streak;
    assert.deepEqual([again?.firstMs, again?.counted], [at(17 + 1 / 60), 1], '15:01 restarts');
  }
  // A body dated BEFORE the streak's last one (the host has no clock of its own until it syncs) restarts it as well.
  const back = fold(three, [one(-30, lostBody)]).state.streak;
  assert.deepEqual([back?.firstMs, back?.counted], [at(-30), 1]);
});

test('★ HOLD and skipped observations neither count nor reset', () => {
  const three = fold(withReference(), minutes(0, 3, lostBody)).state;
  const held = fold(three, [
    ...minutes(3, 5, (seq) => healthyBody(seq, { capWh: 2 * SLOT_WH })), // capacity short, every slot carrying: HOLD
    ...minutes(8, 5, lostBody, { latched: true }),                       // a stale shadow: skipped
    ...minutes(13, 2, lostBody, { online: false }),                      // offline: skipped
  ]);
  assert.deepEqual(held.steps.map((s) => s.skip ?? s.signals?.cls), [...Array(5).fill('HOLD'), ...Array(5).fill('latched'), 'offline', 'offline']);
  assert.deepEqual([held.state.streak?.firstMs, held.state.streak?.counted, held.state.streak?.strong], [at(0), 3, 3]);
  assert.equal(held.state.episode, null);
  // It then goes on from where it stood: three more STRONG make six, and the span is long past ten minutes.
  assert.equal(raisedAt(fold(held.state, minutes(15, 3, (seq) => lostBody(seq + 100)))), at(17));
});

/* ───────────────────────────── IN resets only after 3, over 2 minutes ───────────────────────────── */

test('★ one healthy body does not reset a streak, nor two; three consecutive spanning 2 minutes do', () => {
  const three = fold(withReference(), minutes(0, 3, lostBody)).state;
  assert.equal(fold(three, minutes(3, 1, healthyBody)).state.streak?.counted, 3);
  assert.equal(fold(three, minutes(3, 2, healthyBody)).state.streak?.counted, 3);
  const reset = fold(three, minutes(3, 3, healthyBody));
  assert.equal(reset.state.streak, null);
  assert.equal(reset.steps[1].state.streak?.counted, 3, 'still standing after the second');
  // Two spanning two minutes are not three.
  assert.equal(fold(three, [one(3, healthyBody), one(5, healthyBody)]).state.streak?.counted, 3);
  // Three within one minute do not; the fourth, two minutes after the first, does.
  const quick = fold(three, [one(3, healthyBody), one(3.5, healthyBody), one(4, healthyBody)]);
  assert.equal(quick.state.streak?.counted, 3);
  assert.equal(fold(quick.state, [one(5, healthyBody)]).state.streak, null);
});

test('a counted observation between healthy ones breaks their run', () => {
  const three = fold(withReference(), minutes(0, 3, lostBody)).state;
  const f = fold(three, [one(3, healthyBody), one(4, healthyBody), one(5, lostBody), one(6, healthyBody), one(7, healthyBody)]);
  assert.deepEqual([f.state.streak?.firstMs, f.state.streak?.counted], [at(0), 4]);
});

test('a capacity-fault reading that is only held (every slot carrying) still breaks a run of healthy ones', () => {
  const three = fold(withReference(), minutes(0, 3, lostBody)).state;
  const held = (seq: number): Body => healthyBody(seq, { capWh: 2 * SLOT_WH });
  const f = fold(three, [one(3, healthyBody), one(4, healthyBody), one(5, held), one(6, healthyBody), one(7, healthyBody)]);
  assert.equal(f.steps[2].signals?.cls, 'HOLD');
  assert.deepEqual([f.state.streak?.firstMs, f.state.streak?.counted], [at(0), 3], 'not counted, and the streak stands');
  // A reading whose capacity cannot be compared is neither: the run reaches across it.
  const unknown = (seq: number): Body => quietBody(seq, { capWh: FULL_WH + 5000 });
  assert.equal(fold(three, [one(3, healthyBody), one(4, healthyBody), one(5, unknown), one(6, healthyBody)]).state.streak, null);
});

test('★ one stale healthy body in a real loss does not put the raise off: it still comes at minute 10', () => {
  const f = fold(withReference(), [...minutes(0, 6, lostBody), one(6, healthyBody), ...minutes(7, 5, lostBody)]);
  assert.equal(raisedAt(f), at(10));
});

/* ───────────────────────────── replayed bodies: the tracker's own ring ───────────────────────────── */

test('★ a replayed body is no observation: the same fault-looking body twice counts once', () => {
  const body = lostBody(1);
  const f = fold(withReference(), [observe(at(0), body), observe(at(1), body), observe(at(2), body)]);
  assert.deepEqual(f.steps.map((s) => s.skip), [null, 'replayed', 'replayed']);
  assert.equal(f.state.streak?.counted, 1);
});

test('★ a cloud alternating two cached bodies: each counts once, however long it goes on', () => {
  const a = lostBody(1);
  const b = lostBody(2);
  const f = fold(withReference(), Array.from({ length: 40 }, (_, i) => observe(at(i), i % 2 === 0 ? a : b)));
  assert.deepEqual(f.steps.slice(0, 4).map((s) => s.skip), [null, null, 'replayed', 'replayed']);
  assert.equal(f.state.streak?.counted, 2);
  assert.equal(f.state.episode, null, 'forty minutes of two bodies raise nothing');
});

test('★ the ring remembers 30 bodies: the 30th newest is still known, the 31st is forgotten', () => {
  assert.equal(POOL_OUT_WITNESS_RING, 30);
  const x = healthyBody(9000);
  const start = fold(emptyPoolOutState(), [observe(at(0), x)]).state;
  const after29 = fold(start, minutes(1, 29, healthyBody)).state;
  assert.equal(after29.ring.length, 30);
  assert.equal(advancePoolOut(after29, observe(at(30), x)).skip, 'replayed');
  const after30 = fold(start, minutes(1, 30, healthyBody)).state;
  assert.equal(after30.ring.length, 30);
  assert.equal(advancePoolOut(after30, observe(at(31), x)).skip, null);
});

test('★ the ring is persisted: the first body after a restart is not new if the tracker saw it before', () => {
  const body = lostBody(1);
  const before = fold(withReference(), [observe(at(0), body)]).state;
  const after = advancePoolOut(restart(before), observe(at(1), body));
  assert.equal(after.skip, 'replayed');
  assert.equal(after.state.streak?.counted, 1);
});

test('a latched shadow, a body with no witness and an offline panel are skipped; a body seen while latched stays known', () => {
  const body = lostBody(1);
  const ref = withReference();
  const latched = advancePoolOut(ref, observe(at(0), body, { latched: true }));
  assert.equal(latched.skip, 'latched');
  assert.equal(latched.state.streak, null);
  assert.equal(advancePoolOut(latched.state, observe(at(1), body)).skip, 'replayed', 'the frozen body, served again after the latch released');
  assert.equal(advancePoolOut(ref, observe(at(0), body, { witness: null })).skip, 'no-witness');
  assert.equal(advancePoolOut(ref, observe(at(0), body, { online: false })).skip, 'offline');
  for (const extra of [{ latched: true }, { witness: null }, { online: false }]) {
    const s = advancePoolOut(ref, observe(at(0), body, extra));
    assert.equal(s.signals, null);
    assert.equal(s.state.lastUsableMs, ref.lastUsableMs);
  }
});

/* ───────────────────────────── the flap rule ───────────────────────────── */

/** A loss step: `n` fault readings from a minute; then three healthy ones, which end the streak. */
const step = (from: number, n = 2): PoolObservation[] => [...minutes(from, n, lostBody), ...minutes(from + n, 3, healthyBody)];

test('★ flap: the third confirmed loss step inside 60 minutes raises, at its second reading', () => {
  const two = fold(withReference(), [...step(0), ...step(5)]);
  assert.equal(two.state.episode, null);
  assert.deepEqual(two.state.flaps, [at(0), at(5)]);
  const third = fold(two.state, minutes(10, 2, lostBody));
  assert.equal(third.steps[0].state.episode, null, 'one reading is not a confirmed step');
  assert.equal(raisedAt(third), at(11));
  assert.deepEqual([third.state.episode?.how, third.state.episode?.flapSteps, third.state.episode?.sinceMs], ['flap', 3, at(0)]);
  assert.deepEqual(third.state.flaps, []);
  // Two readings named slot 1 in this step: not a dwell of naming readings, so the raise names none. The set they
  // agree on goes on as the pending change and is latched once it has been named for ten minutes.
  assert.equal(third.state.episode?.slots, null);
  assert.equal(titleOf(third.state), 'Core out of the backup pool: slot not identified');
  const named = fold(third.state, minutes(12, 9, lostBody));
  assert.equal(titleOf(named.steps[7].state), 'Core out of the backup pool: slot not identified', 'minute 19: named for nine minutes');
  assert.equal(titleOf(named.steps[8].state), 'Core out of the backup pool: slot 1', 'minute 20: named for ten');
});

test('flap: two fault readings with a healthy one between them are not "consecutive"', () => {
  const f = fold(withReference(), [one(0, lostBody), one(1, healthyBody), one(2, lostBody)]);
  assert.deepEqual([f.state.streak?.counted, f.state.streak?.stepped, f.state.flaps], [2, false, []]);
  assert.deepEqual(fold(f.state, [one(3, lostBody)]).state.flaps, [at(0)], 'the next one in a row confirms it');
});

test('flap: a step of one reading is not confirmed, and two steps do not raise', () => {
  const f = fold(withReference(), [...step(0), ...step(5, 1), ...step(9), ...step(14, 1)]);
  assert.equal(f.state.episode, null);
  assert.deepEqual(f.state.flaps, [at(0), at(9)]);
});

test('★ flap window: three steps whose first readings span 60:00 raise; at 60:01 the first has left the window', () => {
  const two = fold(withReference(), [...step(0), ...step(30)]).state;
  assert.equal(raisedAt(fold(two, minutes(60, 2, lostBody))), at(61));
  const late = fold(two, [one(60 + 1 / 60, lostBody), one(61 + 1 / 60, lostBody)]);
  assert.equal(late.state.episode, null);
  assert.deepEqual(late.state.flaps, [at(30), at(60 + 1 / 60)]);
});

/* ───────────────────────────── a flap raise's capacity ───────────────────────────── */

test('★★★ a FLAP raise has no dwell behind it: its capacity decides nothing until readings at its count have met a dwell of their own (strong)', () => {
  // Two confirmed one-short steps, then a third step of two readings TWO slots short. On 07-02 and 08-20 the capacity
  // read 30.7 kWh for a while with no Core leaving: two minutes of it must not be a critical pushed at any hour.
  const f = fold(withReference(), [...step(0), ...step(5), ...minutes(10, 2, twoShort)]);
  assert.deepEqual([raisedAt(f), f.state.episode?.how, f.state.episode?.k, f.state.episode?.countedWh], [at(11), 'flap', 2, SLOT_WH]);
  assert.equal(poolOutSeverity(f.state), 'warning', '★ two readings at 30.7 kWh: a warning');
  assert.deepEqual([f.state.episode?.unconfirmed?.counted, f.state.episode?.unconfirmed?.firstMs, f.state.episode?.unconfirmed?.more], [2, at(10), null]);
  // The two-short readings go on: six STRONG readings spanning ten minutes, counted from minute 10, are met at minute 20.
  const on = fold(f.state, minutes(12, 9, twoShort));
  assert.equal(poolOutSeverity(on.steps[7].state), 'warning', 'minute 19: ten readings span nine minutes');
  assert.deepEqual([poolOutSeverity(on.steps[8].state), on.steps[8].state.episode?.unconfirmed, on.steps[8].state.episode?.countedWh], ['critical', null, SLOT_WH]);
  assert.deepEqual(on.steps[8].events.map((e) => e.type), ['set-changed', 'severity'], 'minute 20: the slots are named and the severity moves at the same reading');
  assert.equal(on.steps[8].logs.find((l) => l.text.startsWith('pool-out: severity'))?.text, 'pool-out: severity warning → critical (the confirmed capacity is under half the reference).');
  assert.equal(on.steps[8].logs.some((l) => l.level === 'info' && l.text.startsWith('pool-out: the capacity behind this alarm (30.7 kWh, raised by the flap rule) has now read 2 slots short or more for a full dwell — confirmed')), true);
  // A restart keeps it unconfirmed. A file written before the field existed reads as confirmed, as every raise then was.
  assert.equal(poolOutSeverity(restart(f.state)), 'warning');
  assert.deepEqual(restart(f.state).episode?.unconfirmed, JSON.parse(JSON.stringify(f.state.episode?.unconfirmed)));
  const older = JSON.parse(JSON.stringify(poolOutStateJson(f.state)));
  delete older.episode.unconfirmed;
  assert.equal(poolOutSeverity(poolOutStateFrom(older) as PoolOutState), 'critical');
  // A raise by a DWELL is confirmed from the start (control: the rule above is the flap raise's alone).
  const dwell = fold(withReference(), minutes(0, 11, twoShort)).state;
  assert.deepEqual([dwell.episode?.how, dwell.episode?.unconfirmed, poolOutSeverity(dwell)], ['strong', null, 'critical']);
});

test('★★★ a flap raise on the capacity alone: a warning at its two readings, critical after fifteen readings spanning fifteen minutes at that count', () => {
  const quietStep = (from: number, body: (seq: number) => Body = quietLostBody): PoolObservation[] => [...minutes(from, 2, body), ...minutes(from + 2, 3, healthyBody)];
  const f = fold(withReference(), [...quietStep(0), ...quietStep(5), ...minutes(10, 2, quietTwoShort)]);
  assert.deepEqual([f.state.episode?.how, titleOf(f.state), poolOutSeverity(f.state)], ['flap', '2 Cores out of the backup pool: slots not identified', 'warning']);
  const on = fold(f.state, minutes(12, 14, quietTwoShort));
  assert.equal(poolOutSeverity(on.steps[12].state), 'warning', 'minute 24: fifteen readings span fourteen minutes');
  assert.equal(poolOutSeverity(on.steps[13].state), 'critical', 'minute 25');
  assert.deepEqual(on.steps[13].events.map((e) => e.type), ['severity']);
  // All three dips at 30.7 kWh, capacity alone: the same.
  const all = fold(withReference(), [...quietStep(0, quietTwoShort), ...quietStep(5, quietTwoShort), ...minutes(10, 2, quietTwoShort)]);
  assert.deepEqual([all.state.episode?.how, all.state.episode?.k, poolOutSeverity(all.state)], ['flap', 2, 'warning']);
  // A flap raise ONE Core short is a warning before and after its capacity is confirmed (at minute 20).
  const one1 = fold(withReference(), [...step(0), ...step(5), ...minutes(10, 12, lostBody)]);
  assert.equal(one1.steps.some((x) => poolOutSeverity(x.state) === 'critical'), false);
  assert.notEqual(one1.steps[19].state.episode?.unconfirmed, null, 'minute 19');
  assert.deepEqual([one1.state.episode?.how, one1.steps[20].state.episode?.unconfirmed], ['flap', null]);
});

test('★★ the tally of a flap raise follows a streak\'s own rules: readings fewer slots short do not count, three healthy readings start it again, and so does a gap of more than 15 minutes', () => {
  const raised = fold(withReference(), [...step(0), ...step(5), ...minutes(10, 2, twoShort)]).state;
  // The flap goes on for an hour: three healthy readings, two readings two short. No dwell is ever met.
  const flapping = fold(raised, Array.from({ length: 60 }, (_, i) => one(12 + i, i % 5 < 3 ? healthyBody : twoShort)));
  assert.equal(flapping.steps.some((x) => poolOutSeverity(x.state) === 'critical'), false, '★ never critical on dips of two readings');
  assert.notEqual(flapping.state.episode, null, 'control: the alarm stands');
  assert.deepEqual([flapping.state.episode?.unconfirmed?.counted, flapping.state.episode?.unconfirmed?.firstMs], [2, at(70)], 'the tally holds the last dip alone');
  // A gap of 15:00 carries the tally (six STRONG readings spanning ten minutes from minute 10: met at minute 29)…
  const carried = fold(raised, minutes(26, 4, twoShort));
  assert.deepEqual(carried.steps.map((x) => poolOutSeverity(x.state)), ['warning', 'warning', 'warning', 'critical']);
  // …and after 16 minutes with no reading it starts again: the dwell is counted from minute 27, and met at minute 37.
  const gap = fold(raised, minutes(27, 11, twoShort));
  assert.equal(poolOutSeverity(gap.steps[9].state), 'warning', 'minute 36');
  assert.equal(poolOutSeverity(gap.steps[10].state), 'critical', 'minute 37');
  // Readings ONE slot short say the pool is not two short: they do not count toward the two-slot capacity.
  const fewer = fold(raised, minutes(12, 8, lostBody));
  assert.deepEqual([fewer.state.episode?.k, fewer.state.episode?.unconfirmed?.counted, poolOutSeverity(fewer.state)], [2, 2, 'warning']);
  // A dwell of them is the partial return: a set change, which brings a capacity confirmed by that dwell.
  const part = fold(raised, minutes(12, 11, lostBody));
  assert.deepEqual([part.state.episode?.k, part.state.episode?.unconfirmed, poolOutSeverity(part.state)], [1, null, 'warning']);
  // So does a LARGER count confirmed by a dwell of its own readings. A flap raise one short; two short at minutes
  // 12–17; three healthy readings (the tally starts again); two short at 21 and 22, where the two-slot readings' own
  // ten minutes are met.
  const k1 = fold(withReference(), [...step(0), ...step(5), ...minutes(10, 2, lostBody)]).state;
  assert.deepEqual([k1.episode?.how, k1.episode?.k, k1.episode?.unconfirmed?.counted], ['flap', 1, 2], 'control');
  const more = fold(k1, [...minutes(12, 6, twoShort), ...minutes(18, 3, healthyBody), ...minutes(21, 2, twoShort)]);
  assert.deepEqual([more.steps[9].state.episode?.k, more.steps[9].state.episode?.unconfirmed?.counted], [1, 1], 'minute 21: the tally has one reading since the healthy ones');
  assert.deepEqual([more.state.episode?.k, more.state.episode?.unconfirmed, poolOutSeverity(more.state)], [2, null, 'critical']);
});

/* ───────────────────────────── no silent blindness ───────────────────────────── */

const zeroBody = (seq: number): Body => synthBody({ seq, capWh: 0, poolPct: 0, remainWh: 0, slots: [0, 1, 2].map(() => ({ pct: 60, w: 0 })) });

test('★ a capacity of zero, 5 polls running, with a reference: every slot out (the full set), raised on the capacity dwell, critical', () => {
  assert.equal(POOL_OUT_SKIP_CONVERT_POLLS, 5);
  const f = fold(withReference(), minutes(0, 25, zeroBody));
  assert.deepEqual(f.steps.slice(0, 6).map((s) => [s.skip, s.converted]), [
    ['zero-capacity', null], ['zero-capacity', null], ['zero-capacity', null], ['zero-capacity', null], [null, 'all-out'], [null, 'all-out'],
  ]);
  const sig = f.steps[4].signals as PoolSignals;
  assert.deepEqual([sig.cap.v, sig.cap.k, sig.cap.named, sig.cap.countedWh, sig.cls], ['fault', 3, [1, 2, 3], 0, 'SLOW']);
  assert.equal(f.steps[4].logs.filter((l) => l.level === 'warn').length, 1, 'the conversion is logged once');
  assert.equal(f.steps[5].logs.filter((l) => l.level === 'warn').length, 0);
  // The first counted reading is minute 4; the fifteenth is minute 18 (14 minutes); minute 19 completes 15 minutes.
  assert.equal(raisedAt(f), at(19));
  assert.equal(titleOf(f.state), '3 Cores out of the backup pool: slots 1, 2 and 3');
  assert.equal(poolOutSeverity(f.state), 'critical');
});

test('a capacity of zero with no reference is never turned into a vote', () => {
  const f = fold(emptyPoolOutState(), minutes(0, 40, zeroBody));
  assert.ok(f.steps.every((s) => s.skip === 'zero-capacity' && s.converted === null));
  assert.equal(f.state.streak, null);
});

test('★ a roster slot with no isConnect key, 5 polls running: "not listed", and CAP may name it', () => {
  const gone = (seq: number): Body => quietLostBody(seq, { slots: [{ pct: 60, w: 0 }, { pct: 60, w: 0, isConnect: null }, { pct: 60, w: 0 }] });
  const f = fold(withReference(), minutes(0, 25, gone));
  assert.deepEqual(f.steps.slice(0, 5).map((s) => [s.skip, s.converted]), [
    ['no-isconnect', null], ['no-isconnect', null], ['no-isconnect', null], ['no-isconnect', null], [null, 'not-listed'],
  ]);
  const sig = f.steps[4].signals as PoolSignals;
  assert.deepEqual([sig.cap.v, sig.cap.named, sig.cap.why, sig.cls, sig.named], ['fault', [2], 'not-listed', 'SLOW', [2]]);
  assert.equal(raisedAt(f), at(19));
  assert.equal(titleOf(f.state), 'Core out of the backup pool: slot 2');
  // The same missing key at an unchanged capacity is held, never raised.
  const same = fold(withReference(), minutes(0, 60, (seq) => quietBody(seq, { slots: [{ pct: 60, w: 0 }, { pct: 60, w: 0, isConnect: null }, { pct: 60, w: 0 }] })));
  assert.deepEqual([same.steps[4].converted, same.steps[4].signals?.cap.reason, same.steps[4].signals?.cls], ['not-listed', 'listed-mismatch', 'HOLD']);
  assert.equal(same.state.episode, null);
  assert.equal(same.state.streak, null);
});

test('★ no capacity key, 5 polls running: the capacity is unknown, percent and power are still judged, and nothing raises', () => {
  const noCap = (make: (seq: number) => Body) => (seq: number): Body => ({ ...make(seq), 'backupIncreInfo.backupFullCap': undefined });
  const f = fold(withReference(), minutes(0, 60, noCap(lostBody)));
  assert.deepEqual(f.steps.slice(0, 5).map((s) => [s.skip, s.converted]), [
    ['no-capacity', null], ['no-capacity', null], ['no-capacity', null], ['no-capacity', null], [null, 'cap-unknown'],
  ]);
  const sig = f.steps[4].signals as PoolSignals;
  assert.deepEqual([sig.cap.v, sig.cap.reason, sig.cls, sig.pct.set, sig.flow.set], ['unknown', 'no-capacity', 'NOCAP', [1], [1]]);
  assert.equal(f.state.streak, null, 'NOCAP is computed, logged and recorded, never alarmed');
  assert.equal(f.state.episode, null);
  assert.equal(f.steps.flatMap((s) => s.logs).filter((l) => l.text.includes('recorded, not alarmed')).length, 2, 'logged at most every 30 minutes');
  assert.equal(f.state.lastUsableMs, at(59));
  assert.equal(f.state.lastCapMs, at(-1), 'no capacity verdict since the reference readings');
  // With the slots all in, the same blind body reads IN.
  assert.equal(fold(withReference(), minutes(0, 6, noCap(healthyBody))).steps[5].signals?.cls, 'IN');
});

test('the count is of ONE reason running: another reason in between starts it again', () => {
  const ref = withReference();
  const four = fold(ref, minutes(0, 4, zeroBody));
  const repeat = advancePoolOut(four.state, observe(at(4), zeroBody(0)));
  assert.equal(repeat.skip, 'replayed');
  const more = fold(repeat.state, minutes(5, 5, zeroBody));
  assert.deepEqual(more.steps.map((s) => [s.skip, s.converted]), [
    ['zero-capacity', null], ['zero-capacity', null], ['zero-capacity', null], ['zero-capacity', null], [null, 'all-out'],
  ]);
});

test('★ an incoherent trio is never turned into a vote: a new capacity with the old remainder is no observation', () => {
  const torn = (seq: number): Body => quietLostBody(seq, { poolPct: 67, remainWh: Math.round(0.67 * FULL_WH) });
  const f = fold(withReference(), minutes(0, 60, torn));
  assert.ok(f.steps.every((s) => s.skip === 'incoherent' && s.converted === null && s.signals === null));
  assert.equal(f.state.streak, null);
});

test('★ blind for 30 minutes while the panel is fresh: one WARN line naming the reason — and only one', () => {
  const torn = (seq: number): Body => quietLostBody(seq, { poolPct: 67, remainWh: Math.round(0.67 * FULL_WH) });
  const f = fold(withReference(), minutes(0, 90, torn));
  const warns = f.steps.map((s, i) => ({ i, w: s.logs.filter((l) => l.level === 'warn') })).filter((x) => x.w.length > 0);
  assert.deepEqual(warns.map((x) => x.i), [30]);
  assert.equal(warns[0].w[0].text, 'pool-out: no capacity verdict for 30 min while the panel is fresh (incoherent); a Core leaving the pool cannot be seen until one arrives.');
  assert.deepEqual(f.steps[30].events, [{ type: 'blind', atMs: at(30), reason: 'incoherent' }]);
  assert.equal(f.steps[29].logs.length, 0, 'not at 29 minutes');
  // A stale shadow or an offline panel is not "fresh": the 30 minutes start again after it.
  const broken = fold(withReference(), [...minutes(0, 15, torn), ...minutes(15, 1, torn, { latched: true }), ...minutes(16, 40, torn)]);
  assert.deepEqual(broken.steps.map((s, i) => (s.logs.some((l) => l.level === 'warn') ? i : -1)).filter((i) => i >= 0), [46]);
  // A usable observation ends it.
  const healed = fold(withReference(), [...minutes(0, 20, torn), ...minutes(20, 1, healthyBody), ...minutes(21, 29, torn)]);
  assert.equal(healed.steps.flatMap((s) => s.logs).filter((l) => l.level === 'warn').length, 0);
});

test('★★ a reading that can be used but whose CAPACITY cannot be judged is blind too: a line at first sight, and one WARN after 30 minutes', () => {
  // No reference on file, and slot 1 listed as connected with no capacity of its own: E cannot be formed.
  const noCap = (seq: number): Body => quietLostBody(seq, { slots: [{ pct: 60, w: 0, fullCap: 0 }, { pct: 60, w: 0 }, { pct: 60, w: 0 }] });
  const f = fold(emptyPoolOutState(), minutes(0, 120, noCap));
  assert.deepEqual([f.steps[0].signals?.cap.v, f.steps[0].signals?.cap.reason, f.steps[0].signals?.cls], ['unknown', 'no-slot-capacity', 'HOLD']);
  const said = f.steps.map((x, i) => x.logs.map((l) => `${i} ${l.level}`)).flat();
  assert.deepEqual(said, ['0 info', '30 warn', '30 info', '60 info', '90 info'], 'the reason every 30 minutes, and ONE warn');
  assert.match(f.steps[0].logs[0].text, /^pool-out: a slot reports no capacity of its own and none is on record for it, so the pool's capacity cannot be compared — held \(capacity unknown \(no-slot-capacity, 61\.4 kWh\)/);
  assert.equal(f.steps[30].logs.find((l) => l.level === 'warn')?.text, 'pool-out: no capacity verdict for 30 min while the panel is fresh (no-slot-capacity); a Core leaving the pool cannot be seen until one arrives.');
  assert.deepEqual(f.steps[30].events, [{ type: 'blind', atMs: at(30), reason: 'no-slot-capacity' }]);
  assert.equal(f.steps[29].logs.length, 0, 'not at 29 minutes');
  assert.deepEqual(f.state.blind, { sinceMs: at(0), lastMs: at(119), warned: true });
  assert.equal(poolOutSensorState(f.state, at(119)), 'unknown');
  // A capacity ABOVE the reference that the listed slots do not add up to: the same, with its own line.
  const two = (seq: number): Body => synthBody({ seq, slots: [{}, {}, { isConnect: 0, fullCap: 0, pct: 0, w: 0 }], poolPct: 60 });
  const over = fold(fold(emptyPoolOutState(), minutes(-15, 15, two)).state, minutes(0, 40, (seq) => synthBody({ seq, capWh: FULL_WH, slots: [{}, {}, { isConnect: 0, fullCap: 0, pct: 0, w: 0 }], poolPct: 60 })));
  assert.match(over.steps[0].logs[0].text, /^pool-out: the capacity reads above the sum of the slots the reference counts — held \(capacity unknown \(over, 92\.2 kWh against 61\.4 kWh\)/);
  assert.equal(over.steps[30].logs.find((l) => l.level === 'warn')?.text, 'pool-out: no capacity verdict for 30 min while the panel is fresh (over); a Core leaving the pool cannot be seen until one arrives.');
  // One clock runs through skipped bodies and unjudged ones alike; a capacity verdict ends it.
  const torn = (seq: number): Body => quietLostBody(seq, { poolPct: 67, remainWh: Math.round(0.67 * FULL_WH) });
  const mixed = fold(emptyPoolOutState(), [...minutes(0, 20, torn), ...minutes(20, 15, noCap)]);
  assert.deepEqual(mixed.steps.map((x, i) => (x.logs.some((l) => l.level === 'warn') ? i : -1)).filter((i) => i >= 0), [30]);
  // …and the line says the same thing whichever kind of body the thirtieth minute falls on. Ten usable readings and
  // then skipped ones: "no usable panel reading for 30 min" was false of that half hour.
  const usableFirst = fold(emptyPoolOutState(), [...minutes(0, 10, noCap), ...minutes(10, 25, torn)]);
  assert.equal(usableFirst.steps[30].skip, 'incoherent', 'control: the thirtieth minute is a skipped body');
  assert.equal(usableFirst.steps[30].logs.find((l) => l.level === 'warn')?.text, 'pool-out: no capacity verdict for 30 min while the panel is fresh (incoherent); a Core leaving the pool cannot be seen until one arrives.');
  assert.equal(usableFirst.steps.flatMap((x) => x.logs).some((l) => /no usable panel reading/.test(l.text)), false);
  const healed = fold(emptyPoolOutState(), [...minutes(0, 20, noCap), one(20, quietBody), ...minutes(21, 29, noCap)]);
  assert.equal(healed.steps.flatMap((x) => x.logs).filter((l) => l.level === 'warn').length, 0);
});

test('★★ the blind clock runs only across bodies that follow one another: minutes with no body at all (a restart, an outage) are not "while the panel is fresh"', () => {
  const torn = (seq: number): Body => quietLostBody(seq, { poolPct: 67, remainWh: Math.round(0.67 * FULL_WH) });
  // Twenty blind minutes, the state saved, three hours with no body, then blind bodies again.
  const before = fold(withReference(), minutes(0, 20, torn)).state;
  assert.deepEqual(before.blind, { sinceMs: at(0), lastMs: at(19), warned: false });
  const after = fold(restart(before), minutes(200, 40, torn));
  assert.equal(after.steps[0].logs.length, 0, '★ no WARN at the first body after the gap ("for 200 min" would count the three hours)');
  assert.deepEqual(after.steps[0].state.blind, { sinceMs: at(200), lastMs: at(200), warned: false });
  const warns = after.steps.map((x, i) => (x.logs.some((l) => l.level === 'warn') ? i : -1)).filter((i) => i >= 0);
  assert.deepEqual(warns, [30], 'thirty minutes of bodies after it');
  assert.match(after.steps[30].logs[0].text, /no capacity verdict for 30 min while the panel is fresh \(incoherent\)/);
  // A gap of 15:00 between two blind bodies carries the clock; 15:01 starts it again.
  assert.equal(fold(before, [one(34, torn)]).state.blind?.sinceMs, at(0));
  assert.equal(fold(before, [one(34 + 1 / 60, torn)]).state.blind?.sinceMs, at(34 + 1 / 60));
  // A file from before `lastMs` was kept restores a clock that the next body's gap rule judges from its start.
  const old = JSON.parse(serializePoolOutFile(new Map([[PANEL_SN, before]])));
  delete old.panels[PANEL_SN].blind.lastMs;
  assert.deepEqual(parsePoolOutFile(JSON.stringify(old)).panels.get(PANEL_SN)?.blind, { sinceMs: at(0), lastMs: at(0), warned: false });
});

/* ───────────────────────────── the reference ───────────────────────────── */

test('★ the reference is adopted after CAP has read healthy for 6 observations spanning 10 minutes, with one log line', () => {
  const f = fold(emptyPoolOutState(), minutes(0, 12, healthyBody));
  assert.deepEqual(f.steps.map((s) => s.state.baseline != null), [...Array(10).fill(false), true, true]);
  assert.deepEqual(f.steps[10].events, [{ type: 'baseline', atMs: at(10) }]);
  assert.deepEqual(f.steps.flatMap((s) => s.logs.map((l) => l.text)), ['pool-out: reference adopted — slots 1, 2 and 3, 92.2 kWh.']);
  assert.equal(f.steps[10].changed, true);
  // Five observations spanning twelve minutes are not six; six spanning 9:59 are not ten minutes.
  assert.equal(fold(emptyPoolOutState(), [0, 3, 6, 9, 12].map((m) => one(m, healthyBody))).state.baseline, null);
  const five = fold(emptyPoolOutState(), [0, 2, 4, 6, 8].map((m) => one(m, healthyBody))).state;
  assert.equal(fold(five, [one(9 + 59 / 60, healthyBody)]).state.baseline, null);
  assert.notEqual(fold(five, [one(10, healthyBody)]).state.baseline, null);
});

test('★ the reference is never adopted while a streak or an episode stands', () => {
  // A first start with a Core already out and no reference: the level check still sees it (E from the slots' own
  // capacities), and the alarm raises on the capacity dwell.
  const out = fold(emptyPoolOutState(), minutes(0, 16, quietLostBody));
  assert.equal(raisedAt(out), at(15));
  assert.equal(out.state.baseline, null);
  assert.equal(out.state.episode?.baselineWh, FULL_WH);
  // The capacity comes back with nothing to confirm the slot by: 20 healthy minutes, the episode still stands, and no
  // reference is taken from them.
  const back = fold(out.state, minutes(16, 21, quietBody));
  assert.notEqual(back.state.episode, null);
  assert.equal(back.state.baseline, null);
  // The clear at 30 minutes ends the episode; the reference follows on the next reading.
  const cleared = fold(back.state, minutes(37, 12, quietBody));
  assert.equal(clearedAt(cleared), at(46));
  assert.deepEqual(cleared.state.baseline?.roster, [1, 2, 3]);
});

test('★★ a reference adopted with none before it that leaves a slot out says so, at warn: a Core already out there is not counted', () => {
  // A first start (or a lost state file) with slot 1 not listed as connected: the capacity equals slots 2 and 3, so the
  // reading is healthy against the only roster there is, and nothing can tell slot 1 from an empty slot.
  const unplugged = (seq: number): Body => synthBody({ seq, capWh: 2 * SLOT_WH, poolPct: 64, slots: [{ pct: 0, w: 0, isConnect: 0, hwConnect: 0, fullCap: 0 }, { pct: 65, w: -1107 }, { pct: 63, w: -1061 }] });
  const f = fold(emptyPoolOutState(), minutes(0, 12, unplugged));
  assert.deepEqual([f.state.baseline?.roster, f.state.baseline?.poolCapWh], [[2, 3], 2 * SLOT_WH]);
  assert.deepEqual(f.steps[10].logs, [
    { level: 'info', text: 'pool-out: reference adopted — slots 2 and 3, 61.4 kWh.' },
    { level: 'warn', text: 'pool-out: this reference has none on record before it and leaves out slot 1, which the panel does not list as connected — a Core in that slot that is out of the pool is not counted here, and is not seen leaving.' },
  ]);
  // A slot with no connection flag at all is left out the same way.
  const absent = fold(emptyPoolOutState(), minutes(0, 12, (seq) => synthBody({ seq, capWh: SLOT_WH, poolPct: 65, slots: [{ pct: 65, w: -900 }, { pct: null, w: 0, isConnect: null, fullCap: null }, { pct: null, w: 0, isConnect: null, fullCap: null }] })));
  assert.equal(absent.steps[10].logs[1]?.text, 'pool-out: this reference has none on record before it and leaves out slots 2 and 3, which the panel does not list as connected — a Core in those slots that is out of the pool is not counted here, and is not seen leaving.');
  // Every slot listed: one line, no warn. And an UPDATE of a reference that already left a slot out is not said again.
  assert.equal(fold(emptyPoolOutState(), minutes(0, 12, healthyBody)).steps.flatMap((x) => x.logs).length, 1);
  const moved = fold(f.state, minutes(12, 12, (seq) => unplugged(seq + 500)).map((o) => ({ ...o, diag: { ...o.diag, pool: { ...o.diag.pool, fullCapWh: 2 * SLOT_WH - 600 } } })));
  assert.deepEqual(moved.steps.flatMap((x) => x.logs.map((l) => [l.level, l.text.slice(0, 29)])), [['info', 'pool-out: reference updated —']]);
});

test('★★ the reference is not enlarged while a streak stands — and a streak past its 15-minute gap holds nothing back', () => {
  const two = (seq: number): Body => synthBody({ seq, slots: [{}, {}, { isConnect: 0, fullCap: 0, pct: 0, w: 0 }], poolPct: 60 });
  const ref = fold(emptyPoolOutState(), minutes(-15, 15, two)).state;
  // Three readings one slot short of the two-slot reference start a streak…
  const short = (seq: number): Body => synthBody({ seq, capWh: SLOT_WH, slots: [{ pct: 60, w: 0 }, { pct: 60, w: 0 }, { isConnect: 0, fullCap: 0, pct: 0, w: 0 }], poolPct: 60 });
  const st = fold(ref, minutes(0, 3, short)).state;
  assert.equal(st.streak?.counted, 3);
  // …then the capacity reads ABOVE the reference with every slot idle (held readings: they neither count nor reset).
  const grown = (seq: number): Body => quietBody(seq);
  const f = fold(st, minutes(3, 20, grown));
  assert.deepEqual([f.steps[0].signals?.cap.reason, f.steps[0].signals?.cls], ['over', 'HOLD']);
  assert.equal(f.steps[14].state.baseline?.roster.length, 2, 'minute 17: the grown run has met its dwell since minute 13, but the streak (last counted at minute 2) is 15:00 old');
  assert.notEqual(f.steps[14].state.streak, null);
  assert.equal(f.steps[15].state.baseline?.roster.length, 3, 'minute 18: the streak is past its gap, and the larger reference is adopted');
  assert.equal(f.steps[15].logs[0].text.startsWith('pool-out: reference enlarged — slots 1, 2 and 3, 92.2 kWh (was slots 1 and 2, 61.4 kWh)'), true);
});

test('★ a capacity above the reference for the adoption dwell, matching the slots now listed: the larger reference is adopted, with a log line', () => {
  const two = (seq: number): Body => synthBody({ seq, slots: [{}, {}, { isConnect: 0, fullCap: 0, pct: 0, w: 0 }], poolPct: 60 });
  const ref = fold(emptyPoolOutState(), minutes(-15, 15, two)).state;
  assert.deepEqual([ref.baseline?.roster, ref.baseline?.poolCapWh], [[1, 2], 2 * SLOT_WH]);
  const f = fold(ref, minutes(0, 12, healthyBody));
  assert.deepEqual([f.steps[0].signals?.cap.v, f.steps[0].signals?.cap.reason], ['unknown', 'over']);
  assert.deepEqual(f.steps.map((s) => s.state.baseline?.roster.length), [...Array(10).fill(2), 3, 3]);
  assert.deepEqual([f.state.baseline?.roster, f.state.baseline?.poolCapWh], [[1, 2, 3], FULL_WH]);
  assert.equal(f.steps[10].logs[0].text, "pool-out: reference enlarged — slots 1, 2 and 3, 92.2 kWh (was slots 1 and 2, 61.4 kWh); the panel's capacity has matched its listed slots for 10 min.");
  assert.equal(f.steps[11].signals?.cap.v, 'healthy');
  // 9:59 is not the dwell.
  const five = fold(ref, [0, 2, 4, 6, 8].map((m) => one(m, healthyBody))).state;
  assert.equal(fold(five, [one(9 + 59 / 60, healthyBody)]).state.baseline?.roster.length, 2);
  assert.equal(fold(five, [one(10, healthyBody)]).state.baseline?.roster.length, 3);
  // A capacity above the reference that the listed slots do NOT add up to is never adopted.
  const odd = fold(ref, minutes(0, 60, (seq) => synthBody({ seq, capWh: FULL_WH, slots: [{}, {}, { isConnect: 0, fullCap: 0, pct: 0, w: 0 }], poolPct: 60 })));
  assert.deepEqual([odd.state.baseline?.roster, odd.state.baseline?.poolCapWh, odd.steps[59].signals?.cap.reason], [[1, 2], 2 * SLOT_WH, 'over']);
});

/* ───────────────────────────── the clear ───────────────────────────── */

/** All three in again, but nothing to confirm slot 1 by: every slot idle at one percent. */
const backQuiet = quietBody;
/** The capacity back while slot 1 still carries nothing and the pool percent still leaves it out. */
const backOnPaperOnly = (seq: number): Body => lostBody(seq, { capWh: FULL_WH });

test('★ clear with power evidence: 6 CAP-healthy observations spanning 10 minutes — 5 are not, 9:59 is not', () => {
  const ep = withEpisode();
  assert.equal(titleOf(ep), 'Core out of the backup pool: slot 1');
  const f = fold(ep, minutes(11, 12, healthyBody));
  assert.equal(clearedAt(f), at(21));
  assert.notEqual(f.steps[9].state.episode, null, 'still standing at minute 20');
  assert.deepEqual(f.steps[10].events, [{ type: 'cleared', atMs: at(21), kind: 'returned' }]);
  assert.equal(poolOutLatestEnd(f.state)?.evidence?.by, 'flow');
  // Five spanning twelve minutes are not six.
  const five = fold(ep, [11, 14, 17, 20, 23].map((m) => one(m, healthyBody)));
  assert.notEqual(five.state.episode, null);
  assert.equal(clearedAt(fold(five.state, [one(24, healthyBody)])), at(24));
  // Six spanning 9:59 are not ten minutes.
  const base = fold(ep, [11, 13, 15, 17, 19].map((m) => one(m, healthyBody))).state;
  assert.notEqual(fold(base, [one(20 + 59 / 60, healthyBody)]).state.episode, null);
  assert.equal(clearedAt(fold(base, [one(21, healthyBody)])), at(21));
});

test('★ clear with percent evidence: the pool percent consistent while the returned slot is separable', () => {
  // Nothing discharges, so the power cannot be judged; slot 1 sits 8 points above the others and the pool reads the
  // mean of all three.
  const back = (seq: number): Body => synthBody({ seq, poolPct: 67, slots: [{ pct: 72, w: 0 }, { pct: 65, w: 0 }, { pct: 63, w: 0 }] });
  const f = fold(withEpisode(), minutes(11, 12, back));
  assert.equal(f.steps[0].signals?.flow.v, 'unknown');
  assert.deepEqual(f.steps[0].signals?.pct.separable, [1]);
  assert.equal(clearedAt(f), at(21));
  assert.deepEqual([poolOutLatestEnd(f.state)?.kind, poolOutLatestEnd(f.state)?.evidence?.by], ['returned', 'pct']);
});

test('★ clear on the capacity alone: 18 observations spanning 30 minutes ALWAYS clear — 17 do not, 29:59 does not', () => {
  const ep = withEpisode();
  const f = fold(ep, minutes(11, 32, backQuiet));
  assert.notEqual(f.steps[29].state.episode, null, 'still standing at minute 40: no evidence, so no 10-minute clear');
  assert.equal(clearedAt(f), at(41));
  assert.deepEqual([poolOutLatestEnd(f.state)?.kind, poolOutLatestEnd(f.state)?.evidence], ['capacity-only', null]);
  // Seventeen spanning forty minutes are not eighteen.
  const seventeen = fold(ep, [...minutes(11, 16, backQuiet), one(51, backQuiet)]);
  assert.notEqual(seventeen.state.episode, null);
  assert.equal(clearedAt(fold(seventeen.state, [one(52, backQuiet)])), at(52));
  // Eighteen spanning 29:59 are not thirty minutes.
  const base = fold(ep, minutes(11, 17, backQuiet)).state;
  assert.notEqual(fold(base, [one(40 + 59 / 60, backQuiet)]).state.episode, null);
  assert.equal(clearedAt(fold(base, [one(41, backQuiet)])), at(41));
});

test('★ FLOW and PCT never block a clear: with the capacity back and slot 1 still carrying nothing, it clears at 30 minutes, and says so', () => {
  const f = fold(withEpisode(), minutes(11, 32, backOnPaperOnly));
  assert.deepEqual([f.steps[0].signals?.cap.v, f.steps[0].signals?.pct.set, f.steps[0].signals?.flow.set], ['healthy', [1], [1]]);
  assert.notEqual(f.steps[29].state.episode, null);
  assert.equal(clearedAt(f), at(41));
  assert.equal(poolOutLatestEnd(f.state)?.kind, 'capacity-only');
  assert.ok(f.steps[30].logs.some((l) => l.text.includes('cleared on the capacity while another signal still differs')));
  // The same with nothing but a flag and an error code still standing on the slot.
  const flagOnly = fold(withEpisode(), minutes(11, 32, (seq) => quietBody(seq, { slots: [{ pct: 60, w: 0, ...flagged, errorCodeNum: 533 }, { pct: 60, w: 0 }, { pct: 60, w: 0 }] })));
  assert.equal(flagOnly.steps[0].signals?.flag.v, 'fault');
  assert.equal(clearedAt(flagOnly), at(41));
});

test('★ FLAG never blocks a clear: a flag that stays different after the return changes nothing', () => {
  const back = (seq: number): Body => healthyBody(seq, { slots: [{ pct: 72, w: -710, ...flagged, errorCodeNum: 533 }, { pct: 66, w: -637 }, { pct: 63, w: -601 }] });
  const f = fold(withEpisode(), minutes(11, 12, back));
  assert.equal(f.steps[0].signals?.flag.v, 'fault');
  assert.equal(clearedAt(f), at(21));
  assert.equal(poolOutLatestEnd(f.state)?.kind, 'returned');
});

test('★ a CAP-fault reading starts the clear over; HOLD and skipped readings neither count nor reset it', () => {
  const ep = withEpisode();
  const broken = fold(ep, [...minutes(11, 9, healthyBody), one(20, lostBody), ...minutes(21, 11, healthyBody)]);
  assert.equal(clearedAt(broken), at(31), 'ten minutes from minute 21, not from minute 11');
  // Capacity short with every slot carrying (HOLD) is a capacity fault too: it resets.
  const held = fold(ep, [...minutes(11, 9, healthyBody), one(20, (seq) => healthyBody(seq, { capWh: 2 * SLOT_WH })), ...minutes(21, 11, healthyBody)]);
  assert.equal(clearedAt(held), at(31));
  // Skipped readings and a capacity that cannot be compared: five healthy, ten that are neither, then the sixth.
  const gap = fold(ep, [
    ...minutes(11, 5, healthyBody),
    ...minutes(16, 3, healthyBody, { latched: true }),
    ...minutes(19, 2, (seq) => healthyBody(seq, { capWh: FULL_WH + 5000 })),
    one(21, healthyBody),
  ]);
  assert.deepEqual(gap.steps.slice(5, 10).map((s) => s.skip ?? s.signals?.cap.v), ['latched', 'latched', 'latched', 'unknown', 'unknown']);
  assert.equal(clearedAt(gap), at(21));
  assert.equal(gap.state.ends[0].backAtMs, at(11));
});

test('a count-only episode clears early only on a reading with EVERY slot carrying its share', () => {
  const ep = fold(withReference(), minutes(0, 16, quietLostBody)).state;
  assert.equal(titleOf(ep), 'Core out of the backup pool: slot not identified');
  assert.equal(clearedAt(fold(ep, minutes(16, 12, healthyBody))), at(26));
  // The percent cannot vouch for a slot nobody named.
  const pctOnly = fold(ep, minutes(16, 32, (seq) => synthBody({ seq, poolPct: 67, slots: [{ pct: 72, w: 0 }, { pct: 65, w: 0 }, { pct: 63, w: 0 }] })));
  assert.equal(clearedAt(pctOnly), at(46));
  assert.equal(poolOutLatestEnd(pctOnly.state)?.kind, 'capacity-only');
});

test('★ never cleared by a restart, a skipped observation, a missing panel, an unknown capacity or age', () => {
  const ep = withEpisode();
  const title = titleOf(ep);
  const back = restart(ep);
  assert.deepEqual(poolOutStateJson(back), poolOutStateJson(ep));
  assert.equal(titleOf(back), title);
  assert.notEqual(poolOutAlertParts(back, { nowMs: at(11), timeZone: TZ }), null, 'present at the first alert pass after a restart');
  const week = 7 * 24 * 60;
  for (const [what, extra, make] of [
    ['a stale shadow', { latched: true }, healthyBody],
    ['an offline panel', { online: false }, healthyBody],
    ['no witness', { witness: null }, healthyBody],
    ['a capacity that cannot be compared', {}, (seq: number): Body => healthyBody(seq, { capWh: FULL_WH + 5000 })],
    ['a torn trio', {}, (seq: number): Body => healthyBody(seq, { poolPct: 30, remainWh: Math.round(0.67 * FULL_WH) })],
  ] as Array<[string, Parameters<typeof observe>[2], (seq: number) => Body]>) {
    const f = fold(ep, Array.from({ length: week / 10 }, (_, i) => observe(at(11 + i * 10), make(11 + i * 10), extra)));
    assert.equal(titleOf(f.state), title, what);
    assert.equal(events(f).includes('cleared'), false, what);
    assert.equal(f.state.episode?.sinceMs, at(0), what);
  }
});

/* ───────────────────────────── the latched set ───────────────────────────── */

test('★ the set in the title and in `fault` is latched: readings that only count, or one reading naming another slot, change nothing', () => {
  const ep = withEpisode();
  assert.deepEqual([titleOf(ep), poolOutFault(ep.episode!.k, ep.episode!.slots)], ['Core out of the backup pool: slot 1', 'out:1;k=1']);
  // An hour in which nothing names a slot (the 11-16 charge window had 59 such readings).
  const quiet = fold(ep, minutes(11, 60, quietLostBody));
  assert.equal(titleOf(quiet.state), 'Core out of the backup pool: slot 1');
  assert.equal(events(quiet).includes('set-changed'), false);
  // One reading in which the power points at slot 2.
  const stray = (seq: number): Body => synthBody({ seq, capWh: 2 * SLOT_WH, poolPct: 60, slots: [{ pct: 60, w: -900 }, { pct: 60, w: 0 }, { pct: 60, w: -900 }] });
  const once = fold(ep, [one(11, stray), ...minutes(12, 30, lostBody)]);
  assert.deepEqual(once.steps[0].signals?.named, [2]);
  assert.equal(titleOf(once.state), 'Core out of the backup pool: slot 1');
  assert.equal(events(once).includes('set-changed'), false);
});

test('★ a set change is dwell-confirmed and logged: a second Core out, named', () => {
  const twoOut = (seq: number): Body => synthBody({ seq, capWh: SLOT_WH, poolPct: 65, slots: [{ pct: 72, w: 0 }, { pct: 65, w: -2100 }, { pct: 40, w: 0 }] });
  const f = fold(withEpisode(), minutes(11, 12, twoOut));
  assert.deepEqual([f.steps[0].signals?.cap.k, f.steps[0].signals?.named], [2, [1, 3]]);
  assert.equal(titleOf(f.steps[9].state), 'Core out of the backup pool: slot 1', 'not before the dwell');
  assert.equal(poolOutSeverity(f.steps[9].state), 'warning', 'nor does one reading at 30.7 kWh make it critical');
  assert.equal(titleOf(f.steps[10].state), '2 Cores out of the backup pool: slots 1 and 3');
  assert.equal(poolOutFault(f.state.episode!.k, f.state.episode!.slots), 'out:1+3;k=2');
  assert.deepEqual(f.steps[10].events, [{ type: 'set-changed', atMs: at(21) }, { type: 'severity', atMs: at(21), severity: 'critical' }]);
  assert.ok(f.steps[10].logs.some((l) => l.text.startsWith('pool-out: set changed — Core out of the backup pool: slot 1 → 2 Cores out of the backup pool: slots 1 and 3;')));
  assert.equal(f.state.episode?.countedWh, SLOT_WH);
  assert.equal(f.state.episode?.sinceMs, at(0), 'the same episode');
});

test('a second Core out that nothing names: the named slot is kept and the other is "not identified"', () => {
  const f = fold(withEpisode(), minutes(11, 20, (seq) => quietLostBody(seq, { capWh: SLOT_WH })));
  assert.equal(titleOf(f.steps[14].state), 'Core out of the backup pool: slot 1', 'capacity alone takes 15 minutes');
  assert.equal(titleOf(f.state), '2 Cores out of the backup pool: slot 1 and one not identified');
  assert.equal(poolOutFault(f.state.episode!.k, f.state.episode!.slots), 'out:1+?;k=2');
  assert.equal(poolOutSeverity(f.state), 'critical');
});

test('a count-only episode is named once six STRONG readings over ten minutes agree; a partial return is a set change too', () => {
  const unnamed = fold(withReference(), minutes(0, 16, quietLostBody)).state;
  const named = fold(unnamed, minutes(16, 12, lostBody));
  assert.equal(titleOf(named.steps[9].state), 'Core out of the backup pool: slot not identified');
  assert.equal(titleOf(named.steps[10].state), 'Core out of the backup pool: slot 1');
  // Two out, then the capacity reads one slot short for the capacity dwell: one Core out, which one not established.
  const twoOut = (seq: number): Body => synthBody({ seq, capWh: SLOT_WH, poolPct: 65, slots: [{ pct: 72, w: 0 }, { pct: 65, w: -2100 }, { pct: 40, w: 0 }] });
  const two = fold(withReference(), minutes(0, 11, twoOut)).state;
  assert.equal(titleOf(two), '2 Cores out of the backup pool: slots 1 and 3');
  assert.equal(poolOutSeverity(two), 'critical');
  const part = fold(two, minutes(11, 16, quietLostBody));
  assert.equal(titleOf(part.state), 'Core out of the backup pool: slot not identified');
  assert.equal(poolOutSeverity(part.state), 'warning');
  assert.deepEqual(part.steps[15].events.map((e) => e.type), ['set-changed', 'severity']);
  assert.equal(events(part).includes('cleared'), false, 'the alert stays: no resolve, no new rise');
});

/* ───────────────────────────── severity ───────────────────────────── */

const noGrid = { grid: { present: false, presenceUnknown: false } };
const gridBody = (gridSta: number | null) => (seq: number): Body => lostBody(seq, { gridSta });

test('★ severity: one Core out is a warning; critical when the DWELL-CONFIRMED capacity is under half the reference', () => {
  assert.equal(poolOutSeverity(withReference()), null);
  assert.equal(poolOutSeverity(withEpisode()), 'warning');
  // Half exactly is not under half: a two-Core reference with one out.
  const two = (seq: number, o: Partial<SynthOpts> = {}): Body => synthBody({ seq, slots: [{ pct: 60, w: 0 }, { pct: 60, w: 0 }, { isConnect: 0, fullCap: 0, pct: 0, w: 0 }], poolPct: 60, ...o });
  const half = fold(fold(emptyPoolOutState(), minutes(-15, 15, two)).state, minutes(0, 16, (seq) => two(seq, { capWh: SLOT_WH })));
  assert.deepEqual([half.state.episode?.countedWh, half.state.episode?.baselineWh, poolOutSeverity(half.state)], [SLOT_WH, 2 * SLOT_WH, 'warning']);
  // One Wh under half is critical (the rule reads the confirmed capacity against the reference, not a slot count).
  const st = structuredClone(poolOutStateJson(half.state)) as unknown as PoolOutState;
  st.proc = half.state.proc;
  st.episode!.countedWh = SLOT_WH - 1;
  assert.equal(poolOutSeverity(st), 'critical');
});

test('★ critical by the grid: the add-on\'s verdict absent and known AND the panel\'s own gridSta numeric and not 1, on 3 consecutive readings', () => {
  const ep = withEpisode();
  const f = fold(ep, minutes(11, 3, gridBody(0), noGrid));
  assert.deepEqual(f.steps.map((s) => poolOutSeverity(s.state)), ['warning', 'warning', 'critical']);
  assert.deepEqual(f.steps[2].events, [{ type: 'severity', atMs: at(13), severity: 'critical' }]);
  assert.deepEqual([f.state.episode?.gridCritical, f.state.episode?.gridAbsentAtMs], [true, at(13)]);
  // Out of spec (2) is not 1 either.
  assert.equal(poolOutSeverity(fold(ep, minutes(11, 3, gridBody(2), noGrid)).state), 'critical');
});

test('★ never critical on a reading that is absent, unknown or half of the pair', () => {
  const ep = withEpisode();
  // The gridSta key is missing: null is not "not 1".
  assert.equal(poolOutSeverity(fold(ep, minutes(11, 10, gridBody(null), noGrid)).state), 'warning');
  // One real reading, then two bodies without the key.
  assert.equal(poolOutSeverity(fold(ep, [one(11, gridBody(0), noGrid), one(12, gridBody(null), noGrid), one(13, gridBody(null), noGrid)]).state), 'warning');
  // The add-on's verdict is "unknown" (nothing can be heard).
  assert.equal(poolOutSeverity(fold(ep, minutes(11, 10, gridBody(0), { grid: { present: false, presenceUnknown: true } })).state), 'warning');
  // No verdict at all.
  assert.equal(poolOutSeverity(fold(ep, minutes(11, 10, gridBody(0), { grid: null })).state), 'warning');
  // The verdict says absent while the panel itself reads Grid OK.
  assert.equal(poolOutSeverity(fold(ep, minutes(11, 10, gridBody(1), noGrid)).state), 'warning');
  // The panel reads not-OK while the verdict says present.
  assert.equal(poolOutSeverity(fold(ep, minutes(11, 10, gridBody(0))).state), 'warning');
  // Skipped bodies are no readings.
  assert.equal(poolOutSeverity(fold(ep, minutes(11, 10, gridBody(0), { ...noGrid, latched: true })).state), 'warning');
});

test('★★ a grid reading dated AFTER the newest one is no proof of freshness (the host clock stepped back)', () => {
  const ep = withEpisode(12);
  // "No grid" at minutes 13 and 14; then the clock steps back and the next two are dated minutes 11.2 and 11.4.
  const f = fold(ep, [one(13, gridBody(0), noGrid), one(14, gridBody(0), noGrid), one(11.2, gridBody(0), noGrid), one(11.4, gridBody(0), noGrid)]);
  assert.deepEqual(f.steps.map((x) => poolOutSeverity(x.state)), ['warning', 'warning', 'warning', 'warning'], 'two of the last three are dated ahead of the newest');
  // The third reading on the new clock makes three, each dated at or before the newest and inside five minutes.
  assert.equal(poolOutSeverity(fold(f.state, [one(11.6, gridBody(0), noGrid)]).state), 'critical');
});

test('★ the three readings must each be at most 5 minutes old at the third', () => {
  const ep = withEpisode();
  assert.equal(poolOutSeverity(fold(ep, [one(20, gridBody(0), noGrid), one(22.5, gridBody(0), noGrid), one(25, gridBody(0), noGrid)]).state), 'critical', 'the first is 5:00 old');
  assert.equal(poolOutSeverity(fold(ep, [one(20, gridBody(0), noGrid), one(22.5, gridBody(0), noGrid), one(25 + 1 / 60, gridBody(0), noGrid)]).state), 'warning', 'the first is 5:01 old');
});

test('★ an unknown grid holds the severity; the return to warning is 3 consecutive readings with the grid present', () => {
  const crit = fold(withEpisode(), minutes(11, 3, gridBody(0), noGrid)).state;
  assert.equal(poolOutSeverity(crit), 'critical');
  // Unknown for an hour: still critical.
  assert.equal(poolOutSeverity(fold(crit, minutes(14, 60, gridBody(null), { grid: { present: false, presenceUnknown: true } })).state), 'critical');
  // Two present readings are not three.
  const two = fold(crit, minutes(14, 2, gridBody(1)));
  assert.equal(poolOutSeverity(two.state), 'critical');
  const three = fold(two.state, minutes(16, 1, gridBody(1)));
  assert.equal(poolOutSeverity(three.state), 'warning');
  assert.deepEqual(three.steps[0].events, [{ type: 'severity', atMs: at(16), severity: 'warning' }]);
  assert.deepEqual([three.state.episode?.gridCritical, three.state.episode?.gridAbsentAtMs], [false, null]);
  // The panel reading Grid OK while the add-on's verdict still says absent is not "present": it holds.
  assert.equal(poolOutSeverity(fold(crit, minutes(14, 10, gridBody(1), noGrid)).state), 'critical');
  // Present, present, unknown, present, present: not three consecutive.
  const mixed = fold(crit, [...minutes(14, 2, gridBody(1)), one(16, gridBody(null)), ...minutes(17, 2, gridBody(1))]);
  assert.equal(poolOutSeverity(mixed.state), 'critical');
  assert.equal(poolOutSeverity(fold(mixed.state, minutes(19, 1, gridBody(1))).state), 'warning');
});

test('★ the grid flag is persisted, and it belongs to the episode', () => {
  const crit = fold(withEpisode(), minutes(11, 3, gridBody(0), noGrid)).state;
  assert.equal(poolOutSeverity(restart(crit)), 'critical');
  assert.equal(restart(crit).episode?.gridAbsentAtMs, at(13));
  // The episode ends (the grid still unknown); the next episode starts as a warning.
  const over = fold(crit, minutes(14, 12, healthyBody, { grid: null }));
  assert.equal(over.state.episode, null);
  const next = fold(over.state, minutes(30, 11, lostBody, { grid: null }));
  assert.deepEqual([poolOutSeverity(next.state), next.state.episode?.gridCritical], ['warning', false]);
  // An episode raised while the last three readings already show no grid is critical from its first pass.
  const dark = fold(withReference(), minutes(0, 11, gridBody(0), noGrid));
  assert.equal(raisedAt(dark), at(10));
  assert.equal(poolOutSeverity(dark.state), 'critical');
});

/* ───────────────────────────── the sensor, the orphan hold, the id ───────────────────────────── */

test('★★ the severity line says what moved: the grid, or the capacity the severity reads', () => {
  const lines = (f: Folded): string[] => f.steps.flatMap((x) => x.logs).filter((l) => l.text.startsWith('pool-out: severity')).map((l) => l.text);
  // Two Cores out and one back (a partial return): the count moved. The grid had nothing to do with it.
  const two = fold(withReference(), minutes(0, 11, twoShort)).state;
  assert.deepEqual(lines(fold(two, minutes(11, 16, quietLostBody))), ['pool-out: severity critical → warning (the confirmed capacity is no longer under half the reference).']);
  // A second Core out.
  assert.deepEqual(lines(fold(withEpisode(), minutes(11, 11, twoShort))), ['pool-out: severity warning → critical (the confirmed capacity is under half the reference).']);
  // The grid, both ways.
  const off = fold(withEpisode(), minutes(11, 3, gridBody(0), noGrid));
  assert.deepEqual(lines(off), ['pool-out: severity warning → critical (the panel and the add-on both report no grid).']);
  assert.deepEqual(lines(fold(off.state, minutes(14, 3, gridBody(1)))), ['pool-out: severity critical → warning (the grid reads present again).']);
  // Critical by BOTH: the grid returning moves nothing and says nothing; the count going back to one then says the count.
  const twoNoGrid = (seq: number): Body => twoShort(seq);
  const both = fold(two, minutes(11, 3, (seq) => ({ ...twoNoGrid(seq), 'pd303_mc.masterIncreInfo.gridSta': 0 }), noGrid));
  assert.deepEqual([both.state.episode?.gridCritical, poolOutSeverity(both.state), lines(both)], [true, 'critical', []]);
  const gridBack = fold(both.state, minutes(14, 3, twoShort));
  assert.deepEqual([gridBack.state.episode?.gridCritical, poolOutSeverity(gridBack.state), lines(gridBack)], [false, 'critical', []]);
  assert.deepEqual(lines(fold(gridBack.state, minutes(17, 16, quietLostBody))), ['pool-out: severity critical → warning (the confirmed capacity is no longer under half the reference).']);
});

test('the Home Assistant sensor: ON during an episode; OFF only while the newest capacity verdict is at most 15 minutes old; else unknown', () => {
  assert.equal(poolOutSensorState(emptyPoolOutState(), at(0)), 'unknown');
  const ref = withReference();
  assert.equal(ref.lastCapMs, at(-1));
  assert.equal(poolOutSensorState(ref, at(-1)), 'off');
  assert.equal(poolOutSensorState(ref, at(14)), 'off', '15:00 old');
  assert.equal(poolOutSensorState(ref, at(14) + 1000), 'unknown', '15:01 old');
  assert.equal(poolOutSensorState(ref, at(-2)), 'unknown', 'a clock behind the reading is no proof of freshness');
  // Readings whose capacity cannot be compared do not keep it OFF.
  const blind = fold(ref, minutes(0, 30, (seq) => quietBody(seq, { capWh: FULL_WH + 5000 }))).state;
  assert.equal(blind.lastUsableMs, at(29));
  assert.equal(poolOutSensorState(blind, at(29)), 'unknown');
  const ep = withEpisode();
  assert.equal(poolOutSensorState(ep, at(10)), 'on');
  assert.equal(poolOutSensorState(ep, at(10) + 7 * 24 * 60 * MIN), 'on');
});

test('★★ the sensor is never OFF on a capacity that reads SHORT with no healthy reading inside 15 minutes before it', () => {
  // The capacity one slot short while every slot carries its share: held, never raised. For the first fifteen minutes
  // the last healthy reading is recent and the sensor stays OFF (a dwell in progress reads the same); then it is unknown.
  const carrying = (seq: number): Body => healthyBody(seq, { capWh: 2 * SLOT_WH });
  const f = fold(withReference(), minutes(0, 60, carrying));
  assert.deepEqual([f.steps[0].signals?.cap.v, f.steps[0].signals?.cls], ['fault', 'HOLD']);
  assert.equal(f.state.episode, null);
  assert.equal(poolOutSensorState(f.steps[14].state, at(14)), 'off', 'the healthy reading of minute -1 is 15:00 before this fault reading');
  assert.equal(poolOutSensorState(f.steps[15].state, at(15)), 'unknown', '16:00 before');
  assert.equal(poolOutSensorState(f.state, at(59)), 'unknown');
  // A dwell in progress: eight minutes into a STRONG streak the sensor still reads OFF, and the raise turns it ON.
  const dwell = fold(withReference(), minutes(0, 11, lostBody));
  assert.equal(poolOutSensorState(dwell.steps[8].state, at(8)), 'off');
  assert.equal(poolOutSensorState(dwell.steps[10].state, at(10)), 'on');
  // A first start already short, with no healthy reading on record at all: unknown from the first reading to the raise.
  const first = fold(emptyPoolOutState(), minutes(0, 16, quietLostBody));
  assert.equal(poolOutSensorState(first.steps[0].state, at(0)), 'unknown');
  assert.equal(poolOutSensorState(first.steps[14].state, at(14)), 'unknown');
  assert.equal(poolOutSensorState(first.state, at(15)), 'on');
  // One healthy reading puts it back to OFF.
  assert.equal(poolOutSensorState(fold(f.state, [one(60, healthyBody)]).state, at(60)), 'off');
});

test('★ the orphan hold is released only by what THIS process saw: a raise, or a full clear dwell of healthy capacity', () => {
  assert.equal(poolOutOrphanHoldReleased(emptyPoolOutState()), false);
  // A state read from the file has seen nothing in this process, whatever it holds.
  assert.equal(poolOutOrphanHoldReleased(restart(withReference())), false);
  assert.equal(poolOutOrphanHoldReleased(restart(withEpisode())), false);
  // A raise.
  assert.equal(poolOutOrphanHoldReleased(withEpisode()), true);
  // Healthy capacity: 18 observations spanning 30 minutes, counted from this process's first reading.
  const fresh = restart(withReference());
  assert.equal(poolOutOrphanHoldReleased(fold(fresh, minutes(0, 30, quietBody)).state), false, '30 readings span 29 minutes');
  assert.equal(poolOutOrphanHoldReleased(fold(fresh, minutes(0, 31, quietBody)).state), true);
  assert.equal(poolOutOrphanHoldReleased(fold(fresh, [...minutes(0, 16, quietBody), one(40, quietBody)]).state), false, '17 readings');
  assert.equal(poolOutOrphanHoldReleased(fold(fresh, [...minutes(0, 16, quietBody), one(40, quietBody), one(41, quietBody)]).state), true);
  // A fault reading starts the count over.
  assert.equal(poolOutOrphanHoldReleased(fold(fresh, [...minutes(0, 20, quietBody), one(20, quietLostBody), ...minutes(21, 20, quietBody)]).state), false);
  // A roster that leaves a slot out proves nothing about that slot's Core: with the state file lost and slot 1 not
  // listed as connected, slots 2 and 3 read healthy against themselves for as long as it stays out. Never released.
  const unplugged = (seq: number): Body => synthBody({ seq, capWh: 2 * SLOT_WH, poolPct: 64, slots: [{ pct: 0, w: 0, isConnect: 0, hwConnect: 0, fullCap: 0 }, { pct: 65, w: -1107 }, { pct: 63, w: -1061 }] });
  const lostFile = fold(emptyPoolOutState(), minutes(0, 120, unplugged)).state;
  assert.deepEqual([lostFile.baseline?.roster, lostFile.episode, lostFile.proc.clean], [[2, 3], null, null]);
  assert.equal(poolOutOrphanHoldReleased(lostFile), false);
  // The same lost file with every slot listed and the capacity whole IS thirty minutes of evidence.
  assert.equal(poolOutOrphanHoldReleased(fold(emptyPoolOutState(), minutes(0, 31, quietBody)).state), true);
  // A clear in this process releases it, and the flag is not written to the file.
  const cleared = fold(restart(withEpisode()), minutes(11, 11, healthyBody)).state;
  assert.equal(cleared.episode, null);
  assert.equal(poolOutOrphanHoldReleased(cleared), true);
  assert.equal(poolOutOrphanHoldReleased(restart(cleared)), false);
  // AN END ON FILE releases it, when it is dated at or after the push being resolved: the alarm that was pushed ended
  // on the tracker's own evidence, before the restart. Asked without that time, or with an end older than the push
  // (another episode's), the file releases nothing.
  const endAt = poolOutLatestEnd(cleared)!.atMs;
  assert.equal(endAt, at(21), 'control');
  assert.equal(poolOutOrphanHoldReleased(restart(cleared), at(10)), true, '★ pushed at 23:10, ended at 23:21');
  assert.equal(poolOutOrphanHoldReleased(restart(cleared), endAt), true, 'an end in the instant of the push');
  assert.equal(poolOutOrphanHoldReleased(restart(cleared), endAt + 1), false, '★ an end older than the push is another episode\'s');
  assert.equal(poolOutOrphanHoldReleased(restart(cleared)), false, 'no push time, no release by the file');
  // …and never while an alarm stands again (it is in the alert set, and no orphan).
  const again = fold(cleared, minutes(22, 11, lostBody)).state;
  assert.notEqual(again.episode, null, 'control');
  assert.equal(poolOutOrphanHoldReleased(restart(again), at(10)), false);
  // A panel with an EMPTY slot (two Cores in three): its roster can never earn the clean dwell, state file intact, so
  // the end on file is the only release there is.
  const twoCores = (seq: number): Body => synthBody({ seq, capWh: 2 * SLOT_WH, poolPct: 60, slots: [{ pct: 62, w: -800 }, { pct: 58, w: -760 }, { isConnect: 0, hwConnect: 0, fullCap: 0, pct: 0, w: 0 }] });
  const oneOfTwo = (seq: number): Body => synthBody({ seq, capWh: SLOT_WH, poolPct: 58, slots: [{ pct: 62, w: 0 }, { pct: 58, w: -1560 }, { isConnect: 0, hwConnect: 0, fullCap: 0, pct: 0, w: 0 }] });
  const endedTwo = fold(fold(fold(emptyPoolOutState(), minutes(-15, 15, twoCores)).state, minutes(0, 12, oneOfTwo)).state, minutes(12, 12, twoCores)).state;
  assert.deepEqual([endedTwo.baseline?.roster, endedTwo.episode, poolOutLatestEnd(endedTwo)?.kind], [[1, 2], null, 'returned'], 'control: raised, and ended on evidence');
  const sixHours = fold(restart(endedTwo), minutes(30, 360, twoCores)).state;
  assert.deepEqual([sixHours.proc.cleanDwell, sixHours.proc.clean], [false, null], 'control: six hours of whole capacity earn no clean dwell on two slots of three');
  assert.equal(poolOutOrphanHoldReleased(sixHours), false);
  assert.equal(poolOutOrphanHoldReleased(sixHours, at(11)), true, '★ released by the end on file');
});

test('the alert id: the bare stem for the house panel, the stem and the panel\'s serial for a secondary panel — never a Core\'s serial', () => {
  assert.equal(poolOutAlertId(PANEL_SN, true), 'shp2-pool-out');
  assert.equal(poolOutAlertId(PANEL_SN, false), `shp2-pool-out-${PANEL_SN}`);
});

/* ───────────────────────────── the state file ───────────────────────────── */

test('the state file round-trips every stage of an episode, and never holds the in-process flags', () => {
  let s = withReference();
  const stages: PoolOutState[] = [emptyPoolOutState(), s];
  for (const o of [...minutes(0, 12, lostBody), ...minutes(12, 3, gridBody(0), noGrid), ...minutes(15, 14, healthyBody)]) {
    s = advancePoolOut(s, o).state;
    stages.push(s);
  }
  assert.equal(s.episode, null);
  assert.equal(s.ends.length, 1);
  for (const st of stages) {
    const text = serializePoolOutFile(new Map([[PANEL_SN, st]]));
    assert.equal(text.includes('"proc"'), false);
    assert.deepEqual(poolOutStateJson(restart(st)), JSON.parse(JSON.stringify(poolOutStateJson(st))));
    assert.deepEqual(restart(st).proc, { raised: false, cleanDwell: false, clean: null });
  }
  // The fields those stages never hold: a skip run, the blind clock, a run of healthy readings against a streak, a
  // capacity above the reference, a pending change with a larger count behind it, and a pending decrease.
  const torn = (seq: number): Body => quietLostBody(seq, { poolPct: 67, remainWh: Math.round(0.67 * FULL_WH) });
  const twoShort = (seq: number): Body => quietLostBody(seq, { capWh: SLOT_WH });
  const more: Array<[string, PoolOutState, (st: PoolOutState) => unknown]> = [
    ['a skip run and a blind clock that has warned', fold(withReference(), minutes(0, 31, torn)).state, (st) => [st.skip, st.blind]],
    ['a run of healthy readings against a streak', fold(withReference(), [one(0, lostBody), one(1, healthyBody)]).state, (st) => st.inRun],
    ['a capacity above the reference', fold(withReference(), minutes(0, 3, (seq) => quietBody(seq, { capWh: FULL_WH + 5000 }))).state, (st) => st.grow],
    ['a streak with a larger count behind it', fold(withReference(), [...minutes(0, 3, quietLostBody), one(3, twoShort)]).state, (st) => st.streak?.more],
    ['a pending change carrying a name and a larger count', fold(withReference(), [...minutes(0, 10, lostBody), one(10, (seq) => lostBody(seq, { capWh: SLOT_WH, poolPct: 65, slots: [{ pct: 72, w: 0 }, { pct: 65, w: -2100 }, { pct: 40, w: 0 }] }))]).state, (st) => [st.episode?.change?.names, st.episode?.change?.more]],
    ['a pending decrease', fold(fold(withReference(), minutes(0, 16, twoShort)).state, minutes(16, 3, quietLostBody)).state, (st) => st.episode?.less],
    ['a flap raise whose capacity no dwell has confirmed', fold(withReference(), [...step(0), ...step(5), ...minutes(10, 2, twoShort)]).state, (st) => st.episode?.unconfirmed],
  ];
  for (const [what, st, part] of more) {
    const held = part(st);
    assert.ok(Array.isArray(held) ? held.every((x) => x != null) : held != null, `control: ${what} is in the state`);
    assert.deepEqual(poolOutStateJson(restart(st)), JSON.parse(JSON.stringify(poolOutStateJson(st))), what);
    assert.deepEqual(part(restart(st)), JSON.parse(JSON.stringify(part(st))), what);
  }
  // A chain of larger counts deeper than the panel has slots is not something this code writes.
  const deep = JSON.parse(JSON.stringify(poolOutStateJson(more[3][1])));
  deep.streak.more.more = { ...deep.streak.more, more: { ...deep.streak.more, more: null } };
  assert.equal(poolOutStateFrom(deep), null);
  // Two panels, each its own state.
  const both = parsePoolOutFile(serializePoolOutFile(new Map([['HD31XXX00XXX0001', withEpisode()], ['HD31XXX00XXX0002', withReference()]])));
  assert.deepEqual([...both.panels.keys()], ['HD31XXX00XXX0001', 'HD31XXX00XXX0002']);
  assert.notEqual(both.panels.get('HD31XXX00XXX0001')?.episode, null);
  assert.equal(both.panels.get('HD31XXX00XXX0002')?.episode, null);
});

test('★ an unreadable or corrupt file is no state at all — nothing is invented from it', () => {
  for (const text of ['', 'not json', '[]', 'null', '{}', '{"v":2,"panels":{}}', '{"v":1,"panels":[]}', '{"v":1}']) {
    const r = parsePoolOutFile(text);
    assert.deepEqual([r.panels.size, r.rejected], [0, 1], JSON.stringify(text));
  }
  assert.deepEqual([parsePoolOutFile('{"v":1,"panels":{}}').panels.size, parsePoolOutFile('{"v":1,"panels":{}}').rejected], [0, 0]);
});

test('★ a panel entry with anything out of shape is rejected whole; the other panel is kept', () => {
  const good = poolOutStateJson(withEpisode());
  const breakIt = (edit: (o: any) => void): unknown => { const o = JSON.parse(JSON.stringify(good)); edit(o); return o; };
  const bad: Array<[string, unknown]> = [
    ['a version this code does not write', breakIt((o) => { o.v = 2; })],
    ['an episode with a count that is not a number', breakIt((o) => { o.episode.k = 'one'; })],
    ['an episode with no slots out', breakIt((o) => { o.episode.k = 0; })],
    ['a slot number outside the panel', breakIt((o) => { o.episode.slots = [4]; })],
    ['slots out of order', breakIt((o) => { o.episode.slots = [3, 1]; })],
    ['a time that is not finite', breakIt((o) => { o.episode.sinceMs = null; })],
    ['a ring that is not a list', breakIt((o) => { o.ring = 'abc'; })],
    ['a ring longer than the tracker keeps', breakIt((o) => { o.ring = Array.from({ length: 31 }, (_, i) => String(i)); })],
    ['a reference with no slots', breakIt((o) => { o.baseline.roster = []; })],
    ['a newest reading without its slots', breakIt((o) => { delete o.last.slots; })],
    ['an unknown class', breakIt((o) => { o.last.cls = 'MAYBE'; })],
    ['a severity flag that is not a boolean', breakIt((o) => { o.episode.gridCritical = 'yes'; })],
    ['a list where an object belongs', breakIt((o) => { o.episode = []; })],
  ];
  for (const [what, value] of bad) {
    assert.equal(poolOutStateFrom(value), null, what);
    const r = parsePoolOutFile(JSON.stringify({ v: 1, panels: { HD31XXX00XXX0001: value, HD31XXX00XXX0002: good } }));
    assert.deepEqual([[...r.panels.keys()], r.rejected], [['HD31XXX00XXX0002'], 1], what);
  }
  assert.notEqual(poolOutStateFrom(good), null, 'control: the untouched entry is accepted');
});

test('an end record (the return notice\'s content) is kept 24 hours, then dropped', () => {
  const cleared = fold(withEpisode(), minutes(11, 11, healthyBody)).state;
  assert.equal(cleared.ends.length, 1);
  assert.equal(cleared.ends[0].atMs, at(21));
  const day = 24 * 60;
  assert.equal(advancePoolOut(cleared, one(21 + day, healthyBody)).state.ends.length, 1, '24:00 old');
  const dropped = advancePoolOut(cleared, one(21 + day + 1 / 60, healthyBody));
  assert.deepEqual([dropped.state.ends.length, dropped.changed], [0, true], '24:00:01 old');
  // A skipped body ages it out as well: the record is not held by a stale shadow.
  assert.equal(advancePoolOut(cleared, one(21 + day + 1, healthyBody, { latched: true })).state.ends.length, 0);
});

test('advancePoolOut does not change the state it is given', () => {
  const ep = withEpisode();
  const before = JSON.stringify(ep);
  advancePoolOut(ep, one(11, healthyBody));
  advancePoolOut(ep, one(11, lostBody, { latched: true }));
  assert.equal(JSON.stringify(ep), before);
});

test('what is worth writing at once: a streak starting or ending, a raise, a set change, a severity change, a clear — not each reading', () => {
  const f = fold(withReference(), [...minutes(0, 12, lostBody), ...minutes(12, 12, healthyBody)]);
  const changedAt = f.steps.map((s, i) => (s.changed ? i : -1)).filter((i) => i >= 0);
  // minute 0: the streak starts; 1: it becomes a confirmed loss step; 10: the raise; 12: the clear run starts; 22: the clear.
  assert.deepEqual(changedAt, [0, 1, 10, 12, 22]);
});
