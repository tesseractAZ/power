import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  poolOutTitle, poolOutFault, poolOutDetail, poolOutAlertParts, poolOutEndText, poolOutLatestEnd, poolOutWhen, poolOutDuration, poolVerdictsText,
  emptyPoolOutState, poolSignals, type PoolOutState, type PoolOutEnd,
} from '../src/poolOut.js';
import { poolDiagFromRaw } from '../src/ecoflow/poolDiag.js';
import { shortenDetail, SPOKEN_DETAIL_MAX_CHARS } from '../src/ttsService.js';
import { maskDeviceSerials } from '../src/notify.js';
import {
  synthBody, fold, minutes, at, withReference, withEpisode, healthyBody, lostBody, quietLostBody, quietBody,
  SLOT_WH, FULL_WH, EMPTY_ERR_ENTRY, PANEL_SN, CORE_SNS, type Body, type SynthOpts,
} from './fixtures/poolOutFixtures.js';

/**
 * v1.208.0 — the words of the pool-out alarm and of its return notice (poolOut.ts), as golden strings.
 *
 * Three rules are pinned here beside the wording itself:
 *  - every sentence states what was read and when, so it stays true after a restart, during a stale shadow, with the
 *    slot unidentified, with the error lists unreadable, and while the clear is pending;
 *  - a code, a flag or an error-list entry is quoted as the panel sent it and NO meaning is attached to it;
 *  - the title and the `fault` token are built from the latched count and set alone.
 */

const TZ = 'America/Phoenix';
const detailAt = (s: PoolOutState, nowMs: number = s.last?.atMs ?? at(10)): string => poolOutDetail(s, { nowMs, timeZone: TZ });
const sentences = (text: string): string[] => text.split(/(?<=\.) (?=[A-Z])/);
const EP = withEpisode();
const after = (make: (seq: number) => Body, n = 1, extra: Parameters<typeof minutes>[3] = {}): PoolOutState => fold(EP, minutes(11, n, make, extra)).state;
const lost = (o: Partial<SynthOpts>) => (seq: number): Body => lostBody(seq, o);
const lostSlots = (slot1: Record<string, unknown>) => [{ pct: 72, w: 0, ...slot1 }, { pct: 65, w: -1107 }, { pct: 63, w: -1061 }];

const LEAD = "The panel's backup capacity reads 61.4 kWh: 30.7 kWh, the capacity of 1 slot, under the 92.2 kWh of its 3 slots.";
const SINCE = 'It first read under the sum of its slots at 23:00; the last reading at 92.2 kWh before that was at 22:59.';
const OBSERVED = 'At 23:10 slot 1 delivered 0 W while slots 2 and 3 delivered 1,107 W and 1,061 W.';
const SLOT1 = 'Slot 1 is listed as connected and reads 72%.';
const NO_CODE = "The panel's cloud data carries no error code for slot 1 and three empty error lists.";
const CAUSE = 'Cause not established.';
const CAUSE_QUOTED = 'Cause not established: the values above are quoted as the panel sent them, and no meaning is on record for them.';
const NOW = 'Backup now: 39.3 kWh of 61.4 kWh counted (64%).';
const GRID = 'The grid is present.';

/* ───────────────────────────── titles and the fault token ───────────────────────────── */

test('★ titles: every form, from the latched count and set alone', () => {
  assert.equal(poolOutTitle(1, [1]), 'Core out of the backup pool: slot 1');
  assert.equal(poolOutTitle(1, [3]), 'Core out of the backup pool: slot 3');
  assert.equal(poolOutTitle(2, [1, 3]), '2 Cores out of the backup pool: slots 1 and 3');
  assert.equal(poolOutTitle(3, [1, 2, 3]), '3 Cores out of the backup pool: slots 1, 2 and 3');
  assert.equal(poolOutTitle(1, null), 'Core out of the backup pool: slot not identified');
  assert.equal(poolOutTitle(2, null), '2 Cores out of the backup pool: slots not identified');
  assert.equal(poolOutTitle(2, [1]), '2 Cores out of the backup pool: slot 1 and one not identified');
  assert.equal(poolOutTitle(3, [2]), '3 Cores out of the backup pool: slot 2 and 2 not identified');
  assert.equal(poolOutTitle(1, []), 'Core out of the backup pool: slot not identified');
});

test('★ the fault token: the latched set and count, no code and no reading', () => {
  assert.equal(poolOutFault(1, [1]), 'out:1;k=1');
  assert.equal(poolOutFault(2, [1, 3]), 'out:1+3;k=2');
  assert.equal(poolOutFault(1, null), 'out:?;k=1');
  assert.equal(poolOutFault(2, null), 'out:?;k=2');
  assert.equal(poolOutFault(2, [1]), 'out:1+?;k=2');
  assert.equal(poolOutFault(3, [1, 2, 3]), 'out:1+2+3;k=3');
  // The title and the token do not move while the readings do: an hour of readings, one identity.
  const hour = fold(EP, minutes(11, 60, (seq) => lostBody(seq, { slots: [{ pct: 72, w: 0 }, { pct: 65 - seq / 10, w: -1107 - seq }, { pct: 63 - seq / 10, w: -1061 + seq }], poolPct: 64 - seq / 10 })));
  const ids = new Set(hour.steps.map((s) => { const p = poolOutAlertParts(s.state, { nowMs: s.state.last!.atMs, timeZone: TZ })!; return `${p.title}|${p.fault}`; }));
  assert.deepEqual([...ids], ['Core out of the backup pool: slot 1|out:1;k=1']);
});

test('★ the alert\'s title and fault are the LATCHED ones even when the newest reading counts differently — the lead says what is read now', () => {
  // One reading at 30.7 kWh in which the percent and the power name slots 1 and 3, inside an episode latched on slot 1.
  const twoOut = (seq: number): Body => synthBody({ seq, capWh: SLOT_WH, poolPct: 65, slots: [{ pct: 72, w: 0 }, { pct: 65, w: -2100 }, { pct: 40, w: 0 }] });
  const s = after(twoOut);
  assert.deepEqual([s.last?.cap.k, s.last?.pct.set, s.episode?.k, s.episode?.slots], [2, [1, 3], 1, [1]]);
  const parts = poolOutAlertParts(s, { nowMs: at(11), timeZone: TZ })!;
  assert.deepEqual([parts.severity, parts.title, parts.fault], ['warning', 'Core out of the backup pool: slot 1', 'out:1;k=1']);
  assert.equal(sentences(parts.detail)[0], "The panel's backup capacity reads 30.7 kWh: 61.4 kWh, the capacity of 2 slots, under the 92.2 kWh of its 3 slots.");
});

/* ───────────────────────────── the detail, whole ───────────────────────────── */

test('★ the detail of the 2026-11-14 shape: seven sentences in order', () => {
  assert.equal(detailAt(EP), [LEAD, SINCE, OBSERVED, SLOT1, NO_CODE, CAUSE, NOW, GRID].join(' '));
  const parts = poolOutAlertParts(EP, { nowMs: at(10), timeZone: TZ })!;
  assert.deepEqual([parts.severity, parts.title, parts.fault], ['warning', 'Core out of the backup pool: slot 1', 'out:1;k=1']);
  assert.equal(parts.detail, detailAt(EP));
  assert.deepEqual(parts.facts, [
    { label: 'Counted now', value: '61.4 kWh' },
    { label: 'Before', value: '92.2 kWh' },
    { label: 'Out', value: 'slot 1 (72%, 0 W, listed)' },
    { label: 'Signals', value: 'capacity fault; percent fault; power fault; flags no vote' },
    { label: 'Panel codes', value: 'none read' },
    { label: 'Grid', value: 'present' },
    { label: 'Since', value: '23:00' },
  ]);
  assert.equal(poolOutAlertParts(withReference(), { nowMs: at(0), timeZone: TZ }), null, 'no episode, no alert');
  assert.equal(poolOutDetail(withReference(), { nowMs: at(0), timeZone: TZ }), '');
});

test('★★ the card fact for a slot out: "listed", "not listed", or "no connection flag" — an absent flag is not "not listed"', () => {
  const out = (isConnect: number | null): string | undefined => {
    const body = (seq: number): Body => lostBody(seq, { slots: lostSlots({ isConnect }) });
    const st = isConnect == null
      // A missing key is a skipped body for four polls and "not listed" by the capacity rule from the fifth.
      ? fold(withReference(), minutes(0, 25, body)).state
      : fold(withReference(), minutes(0, 16, body)).state;
    const parts = poolOutAlertParts(st, { nowMs: st.last!.atMs, timeZone: TZ })!;
    assert.equal(parts.title, 'Core out of the backup pool: slot 1');
    return parts.facts.find((x) => x.label === 'Out')?.value;
  };
  assert.equal(out(1), 'slot 1 (72%, 0 W, listed)');
  assert.equal(out(0), 'slot 1 (72%, 0 W, not listed)');
  assert.equal(out(null), 'slot 1 (72%, 0 W, no connection flag)');
  // …as the detail of the same state already says.
  const absent = fold(withReference(), minutes(0, 25, (seq) => lostBody(seq, { slots: lostSlots({ isConnect: null }) }))).state;
  assert.equal(detailAt(absent).includes("Slot 1 has no connection flag in the panel's data and reads 72%."), true);
});

test('★ sentence 7: "No new panel reading since…" once the newest usable observation is over 5 minutes old', () => {
  assert.equal(detailAt(EP, at(15)), [LEAD, SINCE, OBSERVED, SLOT1, NO_CODE, CAUSE, NOW, GRID].join(' '), '5:00 old is not over 5 minutes');
  assert.equal(detailAt(EP, at(15) + 1000), [LEAD, SINCE, OBSERVED, SLOT1, NO_CODE, CAUSE, NOW, GRID, 'No new panel reading since 23:10.'].join(' '));
  // Skipped bodies are not readings: after forty minutes of a stale shadow the sentence still names 23:10.
  const stale = fold(EP, minutes(11, 40, lostBody, { latched: true })).state;
  assert.equal(detailAt(stale, at(51)).endsWith('The grid is present. No new panel reading since 23:10.'), true);
});

test('★ a time on another day carries its day: a 44-hour episode does not read as tonight', () => {
  const nextDay = at(10) + 30 * 60 * 60_000;
  assert.equal(detailAt(EP, nextDay), [
    LEAD,
    'It first read under the sum of its slots at Sat 23:00; the last reading at 92.2 kWh before that was at Sat 22:59.',
    'At Sat 23:10 slot 1 delivered 0 W while slots 2 and 3 delivered 1,107 W and 1,061 W.',
    SLOT1, NO_CODE, CAUSE, NOW, GRID, 'No new panel reading since Sat 23:10.',
  ].join(' '));
  const ctx = { nowMs: Date.UTC(2026, 10, 17, 3, 19), timeZone: TZ };
  assert.equal(poolOutWhen(Date.UTC(2026, 10, 17, 3, 8), ctx), '20:08');
  assert.equal(poolOutWhen(Date.UTC(2026, 10, 15, 6, 35), ctx), 'Sat 23:35');
  assert.equal(poolOutWhen(Date.UTC(2026, 10, 17, 6, 59), ctx), '23:59', 'the same local day');
  assert.equal(poolOutWhen(Date.UTC(2026, 10, 17, 7, 0), ctx), 'Tue 00:00', 'local midnight is the next day');
  assert.equal(poolOutWhen(Date.UTC(2026, 10, 9, 6, 35), ctx), 'Nov 8 23:35', 'beyond six days a weekday would be ambiguous');
  assert.equal(poolOutWhen(Number.NaN, ctx), 'an unknown time');
  assert.equal(poolOutWhen(Date.UTC(2026, 10, 17, 3, 8), { nowMs: ctx.nowMs, timeZone: 'UTC' }), '03:08');
  assert.equal(poolOutWhen(Date.UTC(2026, 10, 17, 3, 8), { nowMs: ctx.nowMs, timeZone: 'Not/AZone' }), '03:08', 'an unusable zone falls back to UTC, never a throw');
  assert.equal(poolOutDuration(44 * 3600_000 + 33 * 60_000 + 12_000), '44 h 33 min');
  assert.equal(poolOutDuration(11 * 60_000), '11 min');
  assert.equal(poolOutDuration(60 * 60_000), '1 h 0 min');
  assert.equal(poolOutDuration(-5), '0 min');
});

/* ───────────────────────────── sentence 1: the lead ───────────────────────────── */

test('★ the lead says what the panel reads now: the shortfall, two slots, every slot', () => {
  const twoOut = (seq: number): Body => synthBody({ seq, capWh: SLOT_WH, poolPct: 65, slots: [{ pct: 72, w: 0 }, { pct: 65, w: -2100 }, { pct: 40, w: 0 }] });
  const two = fold(withReference(), minutes(0, 11, twoOut)).state;
  assert.equal(sentences(detailAt(two))[0], "The panel's backup capacity reads 30.7 kWh: 61.4 kWh, the capacity of 2 slots, under the 92.2 kWh of its 3 slots.");
  const none = fold(withReference(), minutes(0, 20, (seq) => synthBody({ seq, capWh: 0, poolPct: 0, remainWh: 0, slots: [0, 1, 2].map(() => ({ pct: 60, w: 0 })) }))).state;
  assert.equal(sentences(detailAt(none))[0], "The panel's backup capacity reads 0.0 kWh: 92.2 kWh, the capacity of 3 slots, under the 92.2 kWh of its 3 slots.");
});

test('★ while the clear is pending the lead is regenerated — never the stale shortfall', () => {
  const pending = after(healthyBody, 3);
  assert.notEqual(pending.episode, null);
  assert.equal(detailAt(pending), [
    "The panel's backup capacity has read 92.2 kWh, the sum of its 3 slots, since 23:11; it first read under that sum at 23:00, 11 min earlier.",
    OBSERVED, SLOT1, NO_CODE, CAUSE, 'Backup now: 61.7 kWh of 92.2 kWh counted (67%).', GRID,
  ].join(' '));
  assert.equal(detailAt(pending).includes('61.4 kWh'), false);
  // One fault reading and the shortfall is the lead again.
  assert.equal(sentences(detailAt(fold(pending, minutes(14, 1, lostBody)).state))[0], LEAD);
});

test('★★ when the newest reading is short by another count than the title says, the detail says which count the alarm stands at', () => {
  const twoOut = (seq: number): Body => synthBody({ seq, capWh: SLOT_WH, poolPct: 65, slots: [{ pct: 72, w: 0 }, { pct: 65, w: -2100 }, { pct: 40, w: 0 }] });
  // Raised for one Core; the newest reading is two slots short, and has not been for a dwell of its own.
  const one = fold(EP, minutes(11, 1, twoOut)).state;
  assert.equal(poolOutTitle(one.episode!.k, one.episode!.slots), 'Core out of the backup pool: slot 1');
  assert.deepEqual(sentences(detailAt(one)).slice(0, 3), [
    "The panel's backup capacity reads 30.7 kWh: 61.4 kWh, the capacity of 2 slots, under the 92.2 kWh of its 3 slots.",
    'This alarm counts 1 Core out: the capacity has not read 2 slots short for a full dwell (10 to 15 minutes of readings).',
    SINCE,
  ]);
  // The other way: two Cores latched, the newest reading one slot short.
  const two = fold(fold(withReference(), minutes(0, 11, twoOut)).state, minutes(11, 1, lostBody)).state;
  assert.equal(poolOutTitle(two.episode!.k, two.episode!.slots), '2 Cores out of the backup pool: slots 1 and 3');
  assert.equal(sentences(detailAt(two))[1], 'This alarm counts 2 Cores out: the capacity has not read 1 slot short for a full dwell (10 to 15 minutes of readings).');
  // The same count, or a reading whose capacity is whole or cannot be compared: nothing is added.
  assert.equal(detailAt(EP).includes('This alarm counts'), false);
  assert.equal(detailAt(after(healthyBody, 3)).includes('This alarm counts'), false);
  assert.equal(detailAt(after(lost({ capWh: FULL_WH + 5000 }))).includes('This alarm counts'), false);
  // On a critical raised by the grid the grid sentence stays second (the spoken cut carries it); this one follows.
  const grid = fold(EP, [...minutes(11, 3, lost({ gridSta: 0 }), { grid: { present: false, presenceUnknown: false } }), ...minutes(14, 1, (seq) => twoOut(seq), { grid: { present: false, presenceUnknown: false } })]).state;
  assert.deepEqual(sentences(detailAt(grid)).slice(1, 3), ['The panel reported no grid at 23:13.', 'This alarm counts 1 Core out: the capacity has not read 2 slots short for a full dwell (10 to 15 minutes of readings).']);
});

test('★★ ONE healthy reading is said as one reading — "has read … since" starts at the second', () => {
  // One healthy body (a stale one is a reading too), then nothing usable: the lead must not say the capacity "has read"
  // whole "since" then for as long as nothing follows.
  const one = after(healthyBody, 1);
  assert.equal(one.episode?.clear?.n, 1);
  assert.equal(detailAt(one), [
    "One reading, at 23:11, has the panel's backup capacity at 92.2 kWh, the sum of its 3 slots.",
    SINCE, OBSERVED, SLOT1, NO_CODE, CAUSE, 'Backup now: 61.7 kWh of 92.2 kWh counted (67%).', GRID,
  ].join(' '));
  // An hour of bodies that cannot be used later: the same lead, and the stale note says how old it is.
  const torn = (seq: number): Body => quietLostBody(seq, { poolPct: 67, remainWh: Math.round(0.67 * FULL_WH) });
  const hour = fold(one, minutes(12, 60, torn)).state;
  assert.equal(hour.episode?.clear?.n, 1);
  assert.equal(sentences(detailAt(hour, at(71)))[0], "One reading, at Sat 23:11, has the panel's backup capacity at 92.2 kWh, the sum of its 3 slots.", 'read at 00:11 on Sunday');
  assert.equal(detailAt(hour, at(71)).endsWith('No new panel reading since Sat 23:11.'), true);
  // The second healthy reading: "has read … since", and the "first read under" instant moves into the lead.
  const two = after(healthyBody, 2);
  assert.equal(sentences(detailAt(two))[0], "The panel's backup capacity has read 92.2 kWh, the sum of its 3 slots, since 23:11; it first read under that sum at 23:00, 11 min earlier.");
  assert.equal(detailAt(two).includes(SINCE), false);
});

test('★★ an episode with healthy readings between its short ones is never said to have been "under" the sum for its whole length', () => {
  // A flap raise: three two-minute dips in twelve minutes, the capacity whole between them.
  const dip = (from: number) => [...minutes(from, 2, lostBody), ...minutes(from + 2, 3, healthyBody)];
  const flap = fold(withReference(), [...dip(0), ...dip(5), ...minutes(10, 2, lostBody)]).state;
  assert.equal(flap.episode?.how, 'flap');
  const pending = fold(flap, minutes(12, 3, healthyBody)).state;
  const lead = sentences(detailAt(pending))[0];
  assert.equal(lead, "The panel's backup capacity has read 92.2 kWh, the sum of its 3 slots, since 23:12; it first read under that sum at 23:00, 12 min earlier.");
  assert.equal(/after .* under it/.test(detailAt(pending)), false);
  const ended = fold(pending, minutes(15, 30, healthyBody)).state;
  assert.equal(ended.episode, null);
  const notice = endOf(ended).body;
  assert.equal(sentences(notice)[0], "The panel's backup capacity has read 92.2 kWh, the sum of its 3 slots, since 23:12; it first read under that sum at 23:00, 12 min earlier.");
  assert.equal(/under it\b/.test(notice), false);
});

test('the lead when the capacity cannot be compared: the two figures, or that there is none', () => {
  assert.equal(sentences(detailAt(after(lost({ capWh: FULL_WH + 5000 }))))[0], "The panel's backup capacity reads 97.2 kWh; its 3 slots add up to 92.2 kWh.");
  const noK = after((seq) => ({ ...lostBody(seq), 'backupIncreInfo.backupFullCap': undefined }), 6);
  assert.equal(noK.last?.cap.reason, 'no-capacity');
  assert.equal(sentences(detailAt(noK))[0], "The panel's data carries no backup capacity right now.");
  assert.equal(detailAt(noK).includes("Backup now: the panel's pool figures cannot be read together right now."), true);
  // A slot with no capacity on record, and no reference to take it from.
  const noRef = fold(emptyPoolOutState(), minutes(0, 16, quietLostBody)).state;
  const noCap = fold(noRef, minutes(16, 1, (seq) => quietLostBody(seq, { slots: [{ pct: 60, w: 0 }, { pct: 60, w: 0, fullCap: 0 }, { pct: 60, w: 0 }] }))).state;
  assert.equal(sentences(detailAt(noCap))[0], "The panel's backup capacity reads 61.4 kWh; its 3 slots do not all report a capacity.");
});

test('an episode restored with no newest reading: the lead is the latched figures in the past tense, and it says so', () => {
  const restored = { ...structuredClone({ ...EP, proc: undefined }), proc: EP.proc, last: null } as unknown as PoolOutState;
  assert.equal(detailAt(restored, at(12)), [
    "The panel's backup capacity read 61.4 kWh at 23:10: 30.7 kWh, the capacity of 1 slot, under the 92.2 kWh of its 3 slots.",
    SINCE, OBSERVED, CAUSE, 'The newest panel reading is not on record.',
  ].join(' '));
});

/* ───────────────────────────── sentence 2: since when ───────────────────────────── */

test('★ "since when" names the first fault READING and the last full reading — never the step itself', () => {
  assert.equal(sentences(detailAt(EP))[1], SINCE);
  // No reading at the full capacity is on record (a first start with the Core already out).
  const noRef = fold(emptyPoolOutState(), minutes(0, 16, quietLostBody)).state;
  assert.equal(sentences(detailAt(noRef))[1], 'It first read under the sum of its slots at 23:00; no earlier reading at the full capacity is on record.');
  // After a stale shadow the two times are far apart, and both are still true.
  const gap = fold(withReference(), [...minutes(0, 40, healthyBody, { latched: true }), ...minutes(40, 11, lostBody)]).state;
  assert.equal(sentences(detailAt(gap))[1], 'It first read under the sum of its slots at 23:40; the last reading at 92.2 kWh before that was at 22:59.');
  // A flap raise: not "first", and not one continuous stretch.
  const flap = fold(withReference(), [...minutes(0, 2, lostBody), ...minutes(2, 3, healthyBody), ...minutes(5, 2, lostBody), ...minutes(7, 3, healthyBody), ...minutes(10, 2, lostBody)]).state;
  assert.equal(flap.episode?.how, 'flap');
  // The whole reading it names is the one before the LAST of those dips (the capacity was whole between them).
  assert.equal(sentences(detailAt(flap))[1], 'It has read under the sum of its slots 3 times since 23:00; the last reading at 92.2 kWh before the latest of them was at 23:09.');
  // ★ While the clear is pending on ONE reading this sentence stands beside a newer reading at the same figure: it
  // names the reading BEFORE the shortfall, so the two do not contradict each other ("the last reading at 92.2 kWh was
  // at 22:59" under "One reading, at 23:11, has … 92.2 kWh" did).
  const oneWhole = sentences(detailAt(after(healthyBody, 1)));
  assert.deepEqual(oneWhole.slice(0, 2), ["One reading, at 23:11, has the panel's backup capacity at 92.2 kWh, the sum of its 3 slots.", SINCE]);
});

/* ───────────────────────────── sentence 2 (observed): which slot, by what ───────────────────────────── */

test('★ "observed" is the reading that named the slot, with its time and its figures', () => {
  assert.equal(sentences(detailAt(EP))[2], OBSERVED);
  const byPct = fold(withReference(), minutes(0, 11, (seq) => synthBody({ seq, capWh: 2 * SLOT_WH, poolPct: 64, slots: [{ pct: 72, w: 0 }, { pct: 65, w: 0 }, { pct: 63, w: 0 }] }))).state;
  assert.equal(sentences(detailAt(byPct))[2], 'At 23:10 the pool read 64%: the mean of slots 2 and 3 (65% and 63%), not of all 3 with slot 1 (72%).');
  const twoOut = (seq: number): Body => synthBody({ seq, capWh: SLOT_WH, poolPct: 65, slots: [{ pct: 72, w: 0 }, { pct: 65, w: -2100 }, { pct: 40, w: 0 }] });
  assert.equal(sentences(detailAt(fold(withReference(), minutes(0, 11, twoOut)).state))[2], 'At 23:10 slots 1 and 3 delivered 0 W and 0 W while slot 2 delivered 2,100 W.');
  const cap = (slot2: Record<string, unknown>, n = 16): PoolOutState =>
    fold(withReference(), minutes(0, n, (seq) => quietLostBody(seq, { slots: [{ pct: 60, w: 0 }, { pct: 60, w: 0, ...slot2 }, { pct: 60, w: 0 }] }))).state;
  assert.equal(sentences(detailAt(cap({ isConnect: 0 })))[2], 'At 23:15 slot 2 was not listed as connected to the panel.');
  assert.equal(sentences(detailAt(cap({ isConnect: null }, 20)))[2], "At 23:19 the panel's data held no connection flag for slot 2.");
  assert.equal(sentences(detailAt(cap({ fullCap: 0 })))[2], 'At 23:15 slot 2 reported no capacity of its own.');
  const none = fold(withReference(), minutes(0, 20, (seq) => synthBody({ seq, capWh: 0, poolPct: 0, remainWh: 0, slots: [0, 1, 2].map(() => ({ pct: 60, w: 0 })) }))).state;
  assert.equal(sentences(detailAt(none))[2], "At 23:19 the panel's backup capacity read 0.0 kWh.");
});

test('★ with no slot identified the detail says so, and says nothing about any one slot', () => {
  const unnamed = fold(withReference(), minutes(0, 16, quietLostBody)).state;
  assert.equal(detailAt(unnamed), [
    LEAD, SINCE,
    'Which slot is not established: no slot has been named by 6 readings over 10 minutes.',
    "The panel's cloud data carries no error code for any slot and three empty error lists.",
    CAUSE, 'Backup now: 36.9 kWh of 61.4 kWh counted (60%).', GRID,
  ].join(' '));
  const two = fold(withReference(), minutes(0, 16, (seq) => quietLostBody(seq, { capWh: SLOT_WH }))).state;
  assert.equal(sentences(detailAt(two))[2], 'Which slots are not established: no slot has been named by 6 readings over 10 minutes.');
  assert.equal(poolOutAlertParts(unnamed, { nowMs: at(15), timeZone: TZ })!.facts.find((f) => f.label === 'Out')?.value, 'not identified (1 slot)');
});

test('★★ the one push says what the readings POINT AT when they have named a slot for less than the naming dwell — never "the readings do not single out one slot"', () => {
  // A flap raise: six fault readings in three dips, every one of them naming slot 1. Two of them are in the step that
  // raised: not a dwell of naming readings, so the title names none. The detail says what those two point at.
  const dip = (from: number) => [...minutes(from, 2, lostBody), ...minutes(from + 2, 3, healthyBody)];
  const flap = fold(withReference(), [...dip(0), ...dip(5), ...minutes(10, 2, lostBody)]).state;
  assert.deepEqual([flap.episode?.how, poolOutTitle(flap.episode!.k, flap.episode!.slots)], ['flap', 'Core out of the backup pool: slot not identified']);
  assert.equal(sentences(detailAt(flap))[2], 'Which slot is not established: 2 readings since 23:10 point at slot 1, and a slot is named only from 6 such readings over 10 minutes.');
  // A raise on the capacity dwell: five readings named slot 1 (minutes 0, 2, 4, 6, 8), eleven only counted.
  const slow = fold(withReference(), Array.from({ length: 16 }, (_, m) => minutes(m, 1, m % 2 === 0 && m <= 8 ? lostBody : quietLostBody)).flat()).state;
  assert.deepEqual([slow.episode?.how, slow.episode?.slots], ['slow', null]);
  assert.equal(sentences(detailAt(slow))[2], 'Which slot is not established: 5 readings since 23:00 point at slot 1, and a slot is named only from 6 such readings over 10 minutes.');
  // One naming reading; and two Cores.
  const one = fold(fold(withReference(), minutes(0, 16, quietLostBody)).state, minutes(16, 1, lostBody)).state;
  assert.equal(sentences(detailAt(one))[2], 'Which slot is not established: 1 reading since 23:16 points at slot 1, and a slot is named only from 6 such readings over 10 minutes.');
  const twoOut = (seq: number): Body => synthBody({ seq, capWh: SLOT_WH, poolPct: 65, slots: [{ pct: 72, w: 0 }, { pct: 65, w: -2100 }, { pct: 40, w: 0 }] });
  const two = fold(fold(withReference(), minutes(0, 16, (seq) => quietLostBody(seq, { capWh: SLOT_WH }))).state, minutes(16, 3, twoOut)).state;
  assert.equal(sentences(detailAt(two))[2], 'Which slots are not established: 3 readings since 23:16 point at slots 1 and 3, and a slot is named only from 6 such readings over 10 minutes.');
  // Readings that named DIFFERENT slots point at none: the plain sentence.
  const power = (out: number) => (seq: number): Body => synthBody({ seq, capWh: 2 * SLOT_WH, poolPct: 60, slots: [1, 2, 3].map((n) => ({ pct: 60, w: n === out ? 0 : -900 })) });
  const mixed = fold(fold(withReference(), minutes(0, 16, quietLostBody)).state, [...minutes(16, 1, power(1)), ...minutes(17, 1, power(2))]).state;
  assert.equal(sentences(detailAt(mixed))[2], 'Which slot is not established: no slot has been named by 6 readings over 10 minutes.');
  // A pending LARGER count is not a pointer at a slot of this alarm's count.
  const larger = fold(fold(withReference(), minutes(0, 16, quietLostBody)).state, minutes(16, 2, twoOut)).state;
  assert.deepEqual([larger.episode?.k, larger.episode?.change?.k], [1, 2], 'control');
  assert.equal(sentences(detailAt(larger))[3], 'Which slot is not established: no slot has been named by 6 readings over 10 minutes.');
  // Once the six readings span ten minutes the slot is in the title, and the sentence is the reading that named it.
  const named = fold(flap, minutes(12, 9, lostBody)).state;
  assert.equal(poolOutTitle(named.episode!.k, named.episode!.slots), 'Core out of the backup pool: slot 1');
  assert.equal(sentences(detailAt(named))[2], 'At 23:20 slot 1 delivered 0 W while slots 2 and 3 delivered 1,107 W and 1,061 W.');
});

/* ───────────────────────────── sentence 3: the slot's state ───────────────────────────── */

test('the slot-state sentence: listed or not, with a percent or without, and one per named slot', () => {
  assert.equal(sentences(detailAt(EP))[3], SLOT1);
  assert.equal(sentences(detailAt(after(lost({ slots: lostSlots({ isConnect: 0 }) }))))[3], 'Slot 1 is not listed as connected and reads 72%.');
  assert.equal(sentences(detailAt(after(lost({ slots: lostSlots({ pct: null }), poolPct: 64 }))))[3], 'Slot 1 is listed as connected and has no percent reported.');
  assert.equal(sentences(detailAt(after(lost({ slots: lostSlots({ pct: 72.5 }) }))))[3], 'Slot 1 is listed as connected and reads 72.5%.');
  const notListed = fold(withReference(), minutes(0, 20, (seq) => quietLostBody(seq, { slots: [{ pct: 60, w: 0 }, { pct: 60, w: 0, isConnect: null }, { pct: 60, w: 0 }] }))).state;
  assert.equal(sentences(detailAt(notListed))[3], "Slot 2 has no connection flag in the panel's data and reads 60%.");
  const twoOut = (seq: number): Body => synthBody({ seq, capWh: SLOT_WH, poolPct: 65, slots: [{ pct: 72, w: 0 }, { pct: 65, w: -2100 }, { pct: 40, w: 0 }] });
  assert.deepEqual(sentences(detailAt(fold(withReference(), minutes(0, 11, twoOut)).state)).slice(3, 5), ['Slot 1 is listed as connected and reads 72%.', 'Slot 3 is listed as connected and reads 40%.']);
});

/* ───────────────────────────── sentence 4: codes, lists, flags — quoted, nothing more ───────────────────────────── */

const LIST = (() => { const l = Array.from({ length: 20 }, () => EMPTY_ERR_ENTRY) as unknown[]; l[3] = Buffer.from([0, 0, 0, 0, 0, 0, 0x02, 0xa1]).toString('base64'); return l; })();
const LONG_LIST = (() => { const l = LIST.slice(); l[4] = 'zz!'; for (const i of [5, 6, 7, 8, 9]) l[i] = [0, 0, 0, 0, 0, 0, 0, i]; return l; })();

test('★ an error code, error-list entries, flags and panel flags: each quoted as sent, then "cause not established"', () => {
  const s = after(lost({
    slots: lostSlots({ errorCodeNum: 533, ctrlSta: 'BACKUP_CH_STANDBY', backupIsReady: false }),
    set: {
      'pd303_mc.backupIncreInfo.errcode.errCode': LIST,
      'pd303_mc.masterIncreInfo.errcode.errCode': LONG_LIST,
      'pd303_mc.masterIncreInfo.masterRlyErrFlg': 1,
      'pd303_mc.reasonOfStopDischar': 3,
    },
  }));
  assert.equal(detailAt(s), [
    LEAD, SINCE, OBSERVED, SLOT1,
    'The panel reports error code 533 for slot 1.',
    'Its backup error list holds 1 entry: entry 3 is 00 00 00 00 00 00 02 A1.',
    'Its master error list holds 7 entries: entry 3 is 00 00 00 00 00 00 02 A1, entry 4 is an unrecognised value, entry 5 is 00 00 00 00 00 00 00 05, entry 6 is 00 00 00 00 00 00 00 06, +3 more.',
    'It also reports for slot 1: ch1Info.backupIsReady false (the other slots: true), ch1Info.ctrlSta BACKUP_CH_STANDBY (the other slots: BACKUP_CH_DISCHARGE).',
    'The panel also reports masterRlyErrFlg 1 and reasonOfStopDischar 3.',
    CAUSE_QUOTED, NOW, GRID,
  ].join(' '));
  assert.equal(poolOutAlertParts(s, { nowMs: at(11), timeZone: TZ })!.facts.find((f) => f.label === 'Panel codes')?.value, 'error code 533 (slot 1); backup list 1; master list 7');
  // The phone push masks serial-shaped tokens: nothing in this detail is one.
  assert.equal(maskDeviceSerials(detailAt(s)), detailAt(s));
});

test('★ NO sentence attaches a meaning to a code: the number alone, whatever the number', () => {
  for (const code of [1, 17, 461, 500, 533, 599, 600, 4096]) {
    const text = detailAt(after(lost({ slots: lostSlots({ errorCodeNum: code }) })));
    const about = sentences(text).filter((x) => /error code \d/.test(x));
    assert.deepEqual(about, [`The panel reports error code ${code} for slot 1.`], String(code));
    assert.equal(text.includes(CAUSE_QUOTED), true);
  }
  // Every sentence that quotes a code, a list or a flag is one of four fixed forms; none carries a gloss.
  const forms = [
    /^The panel reports error code \d+ for slot [123]\.$/,
    /^Its (backup|master|hall) error list holds \d+ (entry|entries): (entry \d+ is ([0-9A-F]{2}( [0-9A-F]{2})*|an unrecognised value))(, entry \d+ is ([0-9A-F]{2}( [0-9A-F]{2})*|an unrecognised value))*(, \+\d+ more)?\.$/,
    /^It also reports for slot [123]: [A-Za-z0-9.]+ [A-Za-z0-9_ ]+( \((the other slots?: [A-Za-z0-9_ ,]+|earlier: [A-Za-z0-9_ ]+)\))?(, [A-Za-z0-9.]+ [A-Za-z0-9_ ]+( \((the other slots?: [A-Za-z0-9_ ,]+|earlier: [A-Za-z0-9_ ]+)\))?)*\.$/,
    /^The panel also reports [A-Za-z]+ \d+(, [A-Za-z]+ \d+)*( and [A-Za-z]+ \d+)?\.$/,
  ];
  const s = after(lost({
    slots: lostSlots({ errorCodeNum: 533, ctrlSta: 7, backupIsReady: false, isAcOpen: 0, isEnable: 0, isPowerOutput: 0, enableSet: 2, hwConnect: 0 }),
    set: { 'pd303_mc.backupIncreInfo.errcode.errCode': LONG_LIST, 'pd303_mc.loadIncreInfo.hall1IncreInfo.errcode.errCode': LIST, 'pd303_mc.ntcOverTempErr': 1, 'pd303_mc.masterIncreInfo.masterRlyErrFlg': 2, 'pd303_mc.reasonOsStopCharge': 9 },
  }));
  const quoted = sentences(detailAt(s)).slice(4, -3);
  assert.equal(quoted.length, 5);
  for (const q of quoted) assert.equal(forms.some((f) => f.test(q)), true, q);
  assert.equal(quoted[3], 'It also reports for slot 1: hwConnect 0 (the other slots: 1), isEnable 0 (the other slots: 1), ch1EnableSet 2 (the other slots: 1), isAcOpen 0 (the other slots: 1), isPowerOutput 0 (the other slots: 1), ch1Info.backupIsReady false (the other slots: true), ch1Info.ctrlSta value 7 (the other slots: BACKUP_CH_DISCHARGE).');
  assert.equal(quoted[4], 'The panel also reports masterRlyErrFlg 2, ntcOverTempErr 1 and reasonOsStopCharge 9.');
  // None of the words a gloss would need appears anywhere in a detail full of codes.
  for (const word of ['protection', 'BMS', 'band', 'means', 'because', 'fault', 'failure', 'standby', 'emergency', 'over-temperature', 'relay']) {
    assert.equal(new RegExp(`\\b${word}\\b`, 'i').test(detailAt(s)), false, word);
  }
});

test('★ the fields that are recorded but never put in the owner\'s text stay out of it', () => {
  const s = after((seq) => {
    const b = lostBody(seq);
    for (const n of [1, 2, 3]) {
      b[`pd303_mc.backupIncreInfo.Energy${n}Info.emsChgFlag`] = n === 1 ? 0 : 1;
      b[`pd303_mc.backupIncreInfo.Energy${n}Info.isMpptCharge`] = n === 1 ? 1 : 0;
      b[`pd303_mc.backupIncreInfo.Energy${n}Info.chargeLimit`] = n === 1 ? 80 : 0;
      b[`pd303_mc.backupIncreInfo.Energy${n}Info.multPackNum`] = n === 1 ? 5 : 0;
      b[`pd303_mc.backupIncreInfo.ch${n}Info.wakeUpChargeSta`] = n === 1 ? 1 : 0;
    }
    b['pd303_mc.sysCurRunningState'] = 9;
    return b;
  });
  const text = detailAt(s);
  for (const key of ['emsChgFlag', 'isMpptCharge', 'chargeLimit', 'multPackNum', 'wakeUpChargeSta', 'sysCurRunningState']) assert.equal(text.includes(key), false, key);
  assert.equal(text, [LEAD, SINCE, OBSERVED, SLOT1, NO_CODE, CAUSE, NOW, GRID].join(' '));
});

test('★ "no error code" is said only of what was read: a missing code, an unreadable list', () => {
  assert.equal(sentences(detailAt(EP))[4], NO_CODE);
  // The slot's error-code key is missing.
  assert.equal(sentences(detailAt(after(lost({ slots: lostSlots({ errorCodeNum: null }) }))))[4], "The panel's cloud data carries no error-code reading for slot 1 and three empty error lists.");
  // One list is missing.
  assert.equal(sentences(detailAt(after(lost({ set: { 'pd303_mc.masterIncreInfo.errcode.errCode': undefined } }))))[4], "The panel's cloud data carries no error code for slot 1; its error lists could not all be read.");
  // A code, and two lists that are missing or not lists.
  const mixed = after(lost({ slots: lostSlots({ errorCodeNum: 17 }), set: { 'pd303_mc.masterIncreInfo.errcode.errCode': undefined, 'pd303_mc.loadIncreInfo.hall1IncreInfo.errcode.errCode': 'x' } }));
  assert.deepEqual(sentences(detailAt(mixed)).slice(4, 7), ['The panel reports error code 17 for slot 1.', 'Its master and hall error lists could not be read.', CAUSE_QUOTED]);
  // Another slot's code is reported for that slot, and the named slot is not said to have one.
  const other = after(lost({ slots: [{ pct: 72, w: 0 }, { pct: 65, w: -1107, errorCodeNum: 461 }, { pct: 63, w: -1061 }] }));
  assert.equal(sentences(detailAt(other))[4], 'The panel reports error code 461 for slot 2.');
});

test('a flag that differs only from the slot\'s own earlier value is quoted with that value', () => {
  // Every slot's channel state moved together (a charge): each differs from its reference, none from the others.
  const s = after((seq) => lostBody(seq, { slots: [{ pct: 72, w: 0, ctrlSta: 'BACKUP_CH_CHARGE' }, { pct: 65, w: -1107, ctrlSta: 'BACKUP_CH_CHARGE' }, { pct: 63, w: -1061, ctrlSta: 'BACKUP_CH_CHARGE' }] }));
  assert.equal(sentences(detailAt(s))[5], 'It also reports for slot 1: ch1Info.ctrlSta BACKUP_CH_CHARGE (earlier: BACKUP_CH_DISCHARGE).');
});

/* ───────────────────────────── sentence 6: backup now, and the grid ───────────────────────────── */

test('★ the grid sentence: present, not known, or what the panel reported and when — never a guess', () => {
  const noGrid = { grid: { present: false, presenceUnknown: false } };
  assert.equal(detailAt(EP).endsWith(`${NOW} ${GRID}`), true);
  assert.equal(detailAt(after(lost({ gridSta: null }))).endsWith(`${NOW} Grid presence is not known right now.`), true);
  assert.equal(detailAt(after(lost({ gridSta: 0 }), 1, { grid: { present: false, presenceUnknown: true } })).endsWith(`${NOW} Grid presence is not known right now.`), true);
  // One reading with no grid is reported as that reading; it is not a critical.
  const once = after(lost({ gridSta: 0 }), 1, noGrid);
  assert.equal(poolOutAlertParts(once, { nowMs: at(11), timeZone: TZ })!.severity, 'warning');
  assert.equal(detailAt(once).endsWith(`${NOW} The panel reported no grid at 23:11.`), true);
});

test('★ a critical raised by the grid says so SECOND in the detail, and the spoken sentence carries it', () => {
  const noGrid = { grid: { present: false, presenceUnknown: false } };
  const crit = after(lost({ gridSta: 0 }), 3, noGrid);
  const parts = poolOutAlertParts(crit, { nowMs: at(13), timeZone: TZ })!;
  assert.equal(parts.severity, 'critical');
  assert.equal(parts.detail, [LEAD, 'The panel reported no grid at 23:13.', SINCE, OBSERVED, SLOT1, NO_CODE, CAUSE, NOW].join(' '));
  assert.equal(shortenDetail(parts.detail), `${LEAD} The panel reported no grid at 23:13.`);
  assert.equal(parts.spoken, 'Backup capacity reads 61.4 of 92.2 kWh. No grid reported at 23:13.', 'what the voice reads: its own two short sentences, not that cut');
  assert.equal(parts.facts.find((f) => f.label === 'Grid')?.value, 'not detected');
  // While the grid's return is not yet confirmed (fewer than three readings), both facts are stated with their times.
  const back = fold(crit, minutes(14, 2, lost({ gridSta: 1 }))).state;
  assert.equal(poolOutAlertParts(back, { nowMs: at(15), timeZone: TZ })!.severity, 'critical');
  // The card fact keeps step with the detail: still critical by the grid, and the newest reading shows it present.
  assert.equal(poolOutAlertParts(back, { nowMs: at(15), timeZone: TZ })!.facts.find((x) => x.label === 'Grid')?.value, 'not detected; present on the newest reading');
  assert.equal(poolOutAlertParts(crit, { nowMs: at(13), timeZone: TZ })!.facts.find((x) => x.label === 'Grid')?.value, 'not detected');
  assert.equal(detailAt(back).endsWith(`${NOW} Its newest reading shows the grid present.`), true);
  assert.equal(sentences(detailAt(back))[1], 'The panel reported no grid at 23:13.');
});

test('★★ the card fact says how many entries a list HOLDS, as the detail does — not how many of them the reader kept', () => {
  // A list of a hundred non-empty entries: the reader keeps 64 of them and counts them all.
  const noisy = (seq: number): Body => ({ ...lostBody(seq), 'pd303_mc.loadIncreInfo.hall1IncreInfo.errcode.errCode': Array.from({ length: 100 }, (_, i) => i + 1) });
  const st = fold(withReference(), minutes(0, 11, noisy)).state;
  assert.deepEqual([st.last?.errLists.hall?.count, st.last?.errLists.hall?.entries.length], [100, 64], 'control');
  const parts = poolOutAlertParts(st, { nowMs: st.last!.atMs, timeZone: TZ })!;
  assert.equal(parts.facts.find((x) => x.label === 'Panel codes')?.value, 'hall list 100');
  assert.equal(parts.detail.includes('Its hall error list holds 100 entries'), true, 'control: the detail');
});

/* ───────────────────────────── what the voice reads ───────────────────────────── */

test('★ the spoken sentence of every lead: the capacity in one short sentence of its own, never the 200-character cut of the detail', () => {
  assert.equal(SPOKEN_DETAIL_MAX_CHARS, 200);
  const twoOut = (seq: number): Body => synthBody({ seq, capWh: SLOT_WH, poolPct: 65, slots: [{ pct: 72, w: 0 }, { pct: 65, w: -2100 }, { pct: 40, w: 0 }] });
  // Each case: the state, what the voice reads, and the cut of the detail it used to read (the push still starts so).
  const cases: Array<[string, PoolOutState, string, string]> = [
    ['one out', EP, 'Backup capacity reads 61.4 of 92.2 kWh.', LEAD],
    ['two out', fold(withReference(), minutes(0, 11, twoOut)).state, 'Backup capacity reads 30.7 of 92.2 kWh.', "The panel's backup capacity reads 30.7 kWh: 61.4 kWh, the capacity of 2 slots, under the 92.2 kWh of its 3 slots."],
    ['clear pending', after(healthyBody, 3), 'Backup capacity has read 92.2 of 92.2 kWh since 23:11.', "The panel's backup capacity has read 92.2 kWh, the sum of its 3 slots, since 23:11; it first read under that sum at 23:00, 11 min earlier."],
    ['one healthy reading', after(healthyBody, 1), 'Backup capacity read 92.2 of 92.2 kWh at 23:11.', `One reading, at 23:11, has the panel's backup capacity at 92.2 kWh, the sum of its 3 slots. ${SINCE}`],
    // The newest reading's capacity cannot be compared, or is absent: the newest SHORT reading, with its time.
    ['capacity above its slots', after(lost({ capWh: FULL_WH + 5000 })), 'Backup capacity read 61.4 of 92.2 kWh at 23:10.', `The panel's backup capacity reads 97.2 kWh; its 3 slots add up to 92.2 kWh. ${SINCE}`],
    ['no capacity', after((seq) => ({ ...lostBody(seq), 'backupIncreInfo.backupFullCap': undefined }), 6), 'Backup capacity read 61.4 of 92.2 kWh at 23:10.', `The panel's data carries no backup capacity right now. ${SINCE}`],
  ];
  for (const [what, state, spoken, cut] of cases) {
    const parts = poolOutAlertParts(state, { nowMs: state.last?.atMs ?? at(10), timeZone: TZ })!;
    assert.equal(parts.spoken, spoken, what);
    assert.equal(spoken.length <= 60 && spoken.endsWith('.'), true, what);
    // The detail is unchanged by it, and its own cut still ends on a whole sentence (the push begins with it).
    assert.equal(shortenDetail(parts.detail), cut, what);
    assert.equal(cut.endsWith('.') && !cut.endsWith('...'), true, what);
    assert.equal(cut.length <= SPOKEN_DETAIL_MAX_CHARS, true, what);
  }
  assert.equal(poolOutAlertParts(withReference(), { nowMs: at(0), timeZone: TZ }), null, 'no episode, nothing to say');
});

/* ───────────────────────────── the return notice ───────────────────────────── */

const endOf = (s: PoolOutState, nowMs?: number): { title: string; body: string } => {
  const end = poolOutLatestEnd(s) as PoolOutEnd;
  return poolOutEndText(end, { nowMs: nowMs ?? end.atMs, timeZone: TZ });
};

test('★ the return notice, confirmed by power: the capacities, the duration, the slot\'s percent, the percent step', () => {
  const back = fold(EP, minutes(11, 11, healthyBody)).state;
  assert.equal(back.episode, null);
  assert.deepEqual(endOf(back), {
    title: 'Core back in the backup pool: slot 1',
    body: [
      "The panel's backup capacity has read 92.2 kWh, the sum of its 3 slots, since 23:11; it first read under that sum at 23:00, 11 min earlier.",
      'At 23:11 slot 1 delivered 710 W and read 72%.',
      'The pool percent read 64% before and 67% after: the capacity it is a percent of changed between those two readings, so that step is not a measure of charging.',
      'Backup at 23:21: 61.7 kWh of 92.2 kWh counted (67%).',
    ].join(' '),
  });
  // A resolve push waits for quiet hours to end: built the next morning, every figure still carries its own time.
  assert.equal(endOf(back, at(21) + 8 * 3600_000).body, [
    "The panel's backup capacity has read 92.2 kWh, the sum of its 3 slots, since Sat 23:11; it first read under that sum at Sat 23:00, 11 min earlier.",
    'At Sat 23:11 slot 1 delivered 710 W and read 72%.',
    'The pool percent read 64% before and 67% after: the capacity it is a percent of changed between those two readings, so that step is not a measure of charging.',
    'Backup at Sat 23:21: 61.7 kWh of 92.2 kWh counted (67%).',
  ].join(' '));
  assert.equal(poolOutLatestEnd(withReference()), null);
});

test('the return notice, confirmed by the percent; two Cores back; a slot nobody identified', () => {
  const byPct = fold(EP, minutes(11, 11, (seq) => synthBody({ seq, poolPct: 67, slots: [{ pct: 72, w: 0 }, { pct: 65, w: 0 }, { pct: 63, w: 0 }] }))).state;
  assert.equal(endOf(byPct).title, 'Core back in the backup pool: slot 1');
  assert.equal(sentences(endOf(byPct).body)[1], 'At 23:11 the pool read 67%, the mean of all 3 slots with slot 1 (72%).');
  const twoOut = (seq: number): Body => synthBody({ seq, capWh: SLOT_WH, poolPct: 65, slots: [{ pct: 72, w: 0 }, { pct: 65, w: -2100 }, { pct: 40, w: 0 }] });
  const two = fold(fold(withReference(), minutes(0, 11, twoOut)).state, minutes(11, 11, healthyBody)).state;
  assert.deepEqual(endOf(two), {
    title: '2 Cores back in the backup pool: slots 1 and 3',
    body: [
      "The panel's backup capacity has read 92.2 kWh, the sum of its 3 slots, since 23:11; it first read under that sum at 23:00, 11 min earlier.",
      'At 23:11 slots 1 and 3 delivered 710 W and 601 W and read 72% and 63%.',
      'The pool percent read 65% at 23:10 and 67% at 23:11.',
      'Backup at 23:21: 61.7 kWh of 92.2 kWh counted (67%).',
    ].join(' '),
  });
  const unnamed = fold(fold(withReference(), minutes(0, 16, quietLostBody)).state, minutes(16, 11, healthyBody)).state;
  assert.deepEqual(endOf(unnamed), {
    title: 'Core back in the backup pool: slot not identified',
    body: [
      "The panel's backup capacity has read 92.2 kWh, the sum of its 3 slots, since 23:16; it first read under that sum at 23:00, 16 min earlier.",
      'Since then a reading has shown every slot carrying its share of the load.',
      'The pool percent read 60% before and 67% after: the capacity it is a percent of changed between those two readings, so that step is not a measure of charging.',
      'Backup at 23:26: 61.7 kWh of 92.2 kWh counted (67%).',
    ].join(' '),
  });
});

test('★★ two Cores back on DIFFERENT evidence: the notice says each was confirmed, never that a reading had every slot carrying', () => {
  // Slot 1 comes back carrying its share; slot 3 sits near the reserve (its expected share is under 150 W, so its power
  // is not judged) and is vouched for by the pool percent alone. No reading has every slot carrying its share.
  // (Out: slot 2 carries 4 kW alone, so slot 3's expected share is 222 W and the power names both slots, as the percent does.)
  const twoOut = (seq: number): Body => synthBody({ seq, capWh: SLOT_WH, poolPct: 60, slots: [{ pct: 40, w: 0 }, { pct: 60, w: -4000 }, { pct: 20, w: 0 }] });
  const backBody = (seq: number): Body => synthBody({ seq, poolPct: 40, slots: [{ pct: 40, w: -500 }, { pct: 60, w: -917 }, { pct: 20, w: -83 }] });
  const two = fold(withReference(), minutes(0, 11, twoOut)).state;
  assert.equal(poolOutTitle(two.episode!.k, two.episode!.slots), '2 Cores out of the backup pool: slots 1 and 3');
  const back = fold(two, minutes(11, 11, backBody));
  assert.deepEqual(back.steps[0].signals?.flow.slots.map((x) => [x.slot, x.v]), [[1, 'healthy'], [2, 'healthy'], [3, 'unjudged']]);
  assert.equal(back.steps.some((x) => x.signals?.flow.v === 'healthy'), false, 'control: no reading had every slot carrying its share');
  const end = poolOutLatestEnd(back.state) as PoolOutEnd;
  assert.deepEqual([end.kind, end.evidence], ['returned', null]);
  assert.deepEqual(endOf(back.state), {
    title: '2 Cores back in the backup pool: slots 1 and 3',
    body: [
      "The panel's backup capacity has read 92.2 kWh, the sum of its 3 slots, since 23:11; it first read under that sum at 23:00, 11 min earlier.",
      'Since then readings have confirmed slots 1 and 3, each by its power or by the pool percent.',
      'The pool percent read 60% before and 40% after: the capacity it is a percent of changed between those two readings, so that step is not a measure of discharge.',
      'Backup at 23:21: 36.9 kWh of 92.2 kWh counted (40%).',
    ].join(' '),
  });
});

test('★ the return notice on the capacity alone has its own title, and says the capacity is the only evidence', () => {
  const named = fold(EP, minutes(11, 31, quietBody)).state;
  assert.deepEqual(endOf(named), {
    title: 'Backup pool capacity back at the sum of its 3 slots',
    body: [
      "The panel's backup capacity has read 92.2 kWh, the sum of its 3 slots, since 23:11; it first read under that sum at 23:00, 11 min earlier.",
      'No reading since then confirms slot 1 by its power or by the pool percent: the capacity alone is the evidence.',
      'Slot 1 read 60% at 23:41.',
      'The pool percent read 64% before and 60% after: the capacity it is a percent of changed between those two readings, so that step is not a measure of discharge.',
      'Backup at 23:41: 55.3 kWh of 92.2 kWh counted (60%).',
    ].join(' '),
  });
  const unnamed = fold(fold(withReference(), minutes(0, 16, quietLostBody)).state, minutes(16, 31, quietBody)).state;
  assert.deepEqual(endOf(unnamed), {
    title: 'Backup pool capacity back at the sum of its 3 slots',
    body: [
      "The panel's backup capacity has read 92.2 kWh, the sum of its 3 slots, since 23:16; it first read under that sum at 23:00, 16 min earlier.",
      'No reading since then confirms the slot by its power or by the pool percent: the capacity alone is the evidence.',
      'Backup at 23:46: 55.3 kWh of 92.2 kWh counted (60%).',
    ].join(' '),
  });
});

test('★ the percent step is called a membership step only when it is one: 3 points or more between readings 5 minutes apart at most', () => {
  const base = poolOutLatestEnd(fold(EP, minutes(11, 11, healthyBody)).state) as PoolOutEnd;
  const step = (o: Partial<PoolOutEnd>): string | undefined => sentences(poolOutEndText({ ...base, ...o }, { nowMs: base.atMs, timeZone: TZ }).body).find((x) => x.startsWith('The pool percent'));
  const t = base.pctAfterAtMs as number;
  assert.equal(step({ pctBefore: 47, pctAfter: 64 }), 'The pool percent read 47% before and 64% after: the capacity it is a percent of changed between those two readings, so that step is not a measure of charging.');
  assert.equal(step({ pctBefore: 64, pctAfter: 47 }), 'The pool percent read 64% before and 47% after: the capacity it is a percent of changed between those two readings, so that step is not a measure of discharge.');
  assert.equal(step({ pctBefore: 61, pctAfter: 64 }), 'The pool percent read 61% before and 64% after: the capacity it is a percent of changed between those two readings, so that step is not a measure of charging.');
  // Under three points it is only the two readings…
  assert.equal(step({ pctBefore: 61.5, pctAfter: 64 }), 'The pool percent read 61.5% at 23:10 and 64% at 23:11.');
  // …under one point nothing is said…
  assert.equal(step({ pctBefore: 63.5, pctAfter: 64 }), undefined);
  // …and across a gap (a stale shadow between the two readings) the difference may be energy: the readings and their times only.
  assert.equal(step({ pctBefore: 47, pctAfter: 64, pctBeforeAtMs: t - 5 * 60_000 }), 'The pool percent read 47% before and 64% after: the capacity it is a percent of changed between those two readings, so that step is not a measure of charging.');
  assert.equal(step({ pctBefore: 47, pctAfter: 64, pctBeforeAtMs: t - 5 * 60_000 - 1000 }), 'The pool percent read 47% at 23:05 and 64% at 23:11.');
  assert.equal(step({ pctBefore: null }), undefined);
  // What the sentence does NOT say: that nothing was charged in those minutes. A pool can gain three points in five
  // minutes at its full rate, so only the change of the capacity between the two readings is stated.
  for (const o of [{ pctBefore: 47, pctAfter: 64 }, { pctBefore: 64, pctAfter: 47 }]) {
    assert.equal(/not charging|not a discharge|is the change in which slots are counted/.test(step(o) as string), false);
  }
});

/* ───────────────────────────── the log clause, and no serial anywhere ───────────────────────────── */

test('the four verdicts in one log clause', () => {
  const ref = withReference().baseline;
  assert.equal(poolVerdictsText(poolSignals(poolDiagFromRaw(lostBody(1)), ref)), 'capacity fault (61.4 of 92.2 kWh, 1 slot short); percent fault (slot 1); power fault (slot 1); flags no vote');
  assert.equal(poolVerdictsText(poolSignals(poolDiagFromRaw(healthyBody(1)), ref)), 'capacity healthy (92.2 kWh); percent consistent; power healthy; flags no vote');
  assert.equal(poolVerdictsText(poolSignals(poolDiagFromRaw(quietBody(1, { capWh: FULL_WH + 5000 })), ref)), 'capacity unknown (over, 97.2 kWh against 92.2 kWh); percent consistent; power unknown (idle); flags no vote');
  assert.equal(poolVerdictsText(poolSignals(poolDiagFromRaw(quietLostBody(1, { slots: [{ pct: 60, w: 0 }, { pct: 60, w: 0, isConnect: 0, errorCodeNum: 533 }, { pct: 60, w: 0 }] })), ref)),
    "capacity fault (61.4 of 92.2 kWh, 1 slot short, slot 2 by the panel's own listing); percent consistent; power unknown (idle); flags differ (slot 2 error code 533, slot 2 isConnect 0)");
});

test('★ no serial reaches a log line, an alert text, a return notice or the state: the tracker is never given one', () => {
  const run = fold(withReference(), [
    ...minutes(0, 14, lostBody), ...minutes(14, 12, healthyBody),
    ...minutes(26, 20, quietLostBody), ...minutes(46, 40, quietBody),
  ]);
  const everything = [
    ...run.steps.flatMap((s) => s.logs.map((l) => l.text)),
    ...run.steps.map((s) => poolOutDetail(s.state, { nowMs: at(90), timeZone: TZ })),
    ...run.steps.map((s) => JSON.stringify(s.state)),
    ...run.state.ends.map((e) => JSON.stringify(poolOutEndText(e, { nowMs: at(90), timeZone: TZ }))),
  ].join('\n');
  assert.equal(run.state.ends.length, 2, 'control: two episodes ran, one confirmed by power and one cleared on the capacity');
  for (const sn of [PANEL_SN, ...CORE_SNS]) assert.equal(everything.includes(sn), false);
  assert.equal(/[A-Z0-9]{16}/.test(everything), false, 'nothing serial-shaped at all');
});
