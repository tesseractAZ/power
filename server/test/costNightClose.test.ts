import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildNightChargeMorningSummary, type NightChargeCostClose } from '../src/notify.js';
import { overnightSummaryCases } from './fixtures/overnightTextCases.js';

/**
 * v1.209.0 — A COST NIGHT'S MORNING SUMMARY STATES ITS CLOSE (notify.ts buildNightChargeMorningSummary `cost`,
 * costNightAccount; index.ts sendRestoreSummary).
 *
 * Until this release a night with no outage line stated no close. On 2026-11-16 a top-up that two of three slots
 * never took closed at 49% against an announced 56.7% under the title "reserve restored to 16%" and the lead
 * "completed". The summary now takes the record's own account of such a night (`cost`): what switched the
 * force-charge off, the pool as read when the account goes, the level the evening notice named, and the ON
 * re-issues made. A night whose force-charge did not run, did not take effect or was never confirmed short of its
 * stop goes under a lead and a title of its own.
 *
 * What is held here, word for word on title and body:
 *  C1 — every row of the account: ran (target OFF, window-end OFF, no OFF, every other OFF reason with and without
 *       its clock, one and two re-issues); failed on every slot and on some (0 and 1 re-issues); unconfirmed (a
 *       target OFF, a window-end OFF, no OFF); never started (a start announced, with and without the grid read as
 *       lost; a level other than the stop announced: the words of v1.208.0).
 *  C2 — the close clause in its three forms, each with and without an announced level, and the one-decimal rounding
 *       of the reading and of the levels ("a start was announced" is round1(announced) === round1(stop)).
 *  C3 — byte-identity: with `cost` omitted, null or undefined the text is the frozen text of the releases before
 *       (fixtures/lineNightCostTexts.v1199.json, fixtures/overnightTextGolden.json), and omitted equals null on
 *       the shapes no fixture holds.
 *  C4 — `cost` is never read on a night whose record carries a line, on a reserve-only night, on one that ended
 *       early, or with no finite stop on the outcome.
 *  C5 — unusable input (non-finite figures, an unusable re-issue count, an unknown OFF reason) neither throws nor
 *       prints NaN, undefined, null or Infinity.
 *  C6 — the flagged title keeps the restore half in each of its three forms.
 *  C7 — the wiring, from source: index.ts passes `cost` only where the record carries no line; the builder calls
 *       costNightAccount only where neither the input nor the outcome carries one.
 *  C8 — severity and dedupId are the summary's own on every flagged shape.
 *
 * Shapes whose present words are reported as findings are exercised for "does not throw, prints no token" only and
 * are not held word for word: an empty partial-slot list; an unconfirmed night with a target OFF and no OFF clock, or
 * with a re-issue; a failed night with an unusable re-issue count; an early OFF beside a re-issue (two brackets in a
 * row); a close with neither a reading nor an announced level beside the expected figure (the same). A never-started
 * night is held flagged with the pool read under the announced level; with the pool read at or above it, its lead and
 * title are not held. An OFF time that is finite and outside the Date range makes the builder throw (the clock
 * formatter's RangeError): reported, and not exercised.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX = readFileSync(resolve(HERE, '../src/index.ts'), 'utf8');
const NOTIFY = readFileSync(resolve(HERE, '../src/notify.ts'), 'utf8');
/** The morning account of a cost night as v1.199.1 wrote it (lineForceChargeAtRisk.test.ts reads the same file). */
const COST_TEXTS = JSON.parse(readFileSync(resolve(HERE, 'fixtures/lineNightCostTexts.v1199.json'), 'utf8')) as Record<string, string>;
/** The overnight words captured before the day-aware formatter (overnightTextGolden.test.ts reads the same file). */
const GOLDEN = JSON.parse(readFileSync(resolve(HERE, 'fixtures/overnightTextGolden.json'), 'utf8')) as {
  summary: Array<{ name: string; push: unknown }>;
};

type Input = Parameters<typeof buildNightChargeMorningSummary>[0];
type Outcome = NonNullable<Input['forceCharge']>;
/** An outcome whose force-charge rode the night: every kind but 'none'. */
type Riding = Exclude<Outcome, { kind: 'none' }>;

/** UTC ms of a Phoenix wall time (UTC-7, no DST). */
const phx = (mo: number, d: number, h: number, mi = 0): number => Date.UTC(2026, mo - 1, d, h + 7, mi);
const DAY = '2026-11-16';
const OFF_1220 = phx(11, 17, 0, 20); // "12:20am"
const OFF_230 = phx(11, 17, 2, 30);  // "2:30am"
const OFF_312 = phx(11, 17, 3, 12);  // "3:12am"
const CLOSE_5 = phx(11, 17, 5);      // "5am"

const ran: Riding = { kind: 'ran', stopPct: 56.7, expectedLeg: true };
const neverStarted: Riding = { kind: 'neverStarted', stopPct: 56.7, expectedLeg: true };
const failedAll: Riding = { kind: 'failed', stopPct: 56.7, expectedLeg: true, partialSlots: null };
const failedSome: Riding = { kind: 'failed', stopPct: 56.7, expectedLeg: true, partialSlots: [2, 3] };
const unconfirmed: Riding = { kind: 'unconfirmed', stopPct: 56.7, expectedLeg: true };

/** The close account of the 2026-11-16 night: 56.7% announced, 49% read at the close, no OFF, no re-issue. */
const close = (over: Partial<NightChargeCostClose> = {}): NightChargeCostClose => ({
  announcedLevelPct: 56.7, poolPct: 49, readLate: false, offReason: null, offAtMs: null, onReissues: 0, ...over,
});
/** A written night: reserve 50%, restored to 16%, ~6.2 kWh expected (stated only beside a force-charge that ran). */
const night = (forceCharge: Outcome | null, cost?: NightChargeCostClose | null, over: Partial<Input> = {}): Input => ({
  day: DAY, targetPct: 50, restorePct: 16, expectedKwh: 6.2, forceCharge, ...(cost !== undefined ? { cost } : {}), ...over,
});
const msg = (i: Input) => buildNightChargeMorningSummary(i);
/** The same, failing the assertion (with what was built) where the builder throws. */
const built = (i: Input, what: string): ReturnType<typeof msg> => {
  try { return msg(i); } catch (e) { return assert.fail(`${what}: threw ${String(e)}`); }
};

const TAIL = "Delivery vs plan scores in the ledger at tomorrow evening's update.";
const RESTORED = 'the reserve is restored to 16%. ';
const ACKED = 'the restore to 16% was sent (the EcoFlow cloud acknowledged it), and the panel has not read it back yet. ';
const STOOD = 'no restore was due. ';
const COMPLETED = 'completed';
const NO_FORCE_CHARGE = 'closed without its force-charge';
const NOT_EVERY_SLOT = 'closed with its force-charge not applied on every slot';
const UNCONFIRMED = 'closed with its force-charge unconfirmed';
/** The whole body: the lead, the night's account, how the reserve was left, the ledger line. */
const body = (lead: string, account: string, restored = RESTORED): string =>
  `Supervised night charge for ${DAY} ${lead}: ${account}; ${restored}${TAIL}`;

const T_PLAIN = 'Night-charge: reserve restored to 16%';
const T_NOT_RUN = 'Night-charge: force-charge did not run — reserve restored to 16%';
const T_NO_EFFECT = 'Night-charge: force-charge did not take effect — reserve restored to 16%';
const T_SLOTS_2_3 = 'Night-charge: force-charge not applied on slot(s) 2, 3 — reserve restored to 16%';
const T_NOT_CONFIRMED = 'Night-charge: force-charge not confirmed — reserve restored to 16%';

const FAILED_SOME_WORDS = 'reserve raised to 50%; force-charge toward ~56.7% was switched ON but did not take effect on slot(s) 2, 3 '
  + '(the buy above the reserve did not happen on those slot(s))';
const AT_49 = '; the pool read 49% at the close, against the ~56.7% the evening notice named';

/** What forceChargeOffWords says for each reason it knows (notify.ts; held to the source below). */
const OFF_WORDS: Record<string, string> = {
  cancelled: 'the night was cancelled',
  reverted: 'the reserve was restored',
  gridLoss: 'the grid was lost',
  disabled: 'the force-charge was disabled by the options',
  maxRun: 'the run backstop',
  target: 'it reached its target',
  onPeakGuard: 'the on-peak guard, an hour before on-peak',
  foreign: 'the reserve was set outside the add-on',
};

const sliceOf = (src: string, head: string): string => {
  const at = src.indexOf(head);
  assert.ok(at >= 0, `${head} not found`);
  return src.slice(at, src.indexOf('\n}\n', at));
};

/* ══ C1 — the account, row by row ═══════════════════════════════════════════════════════════════════════ */

test('★★★ C1 the 2026-11-16 shape: a top-up two slots never took is flagged, with the close beside the announced level', () => {
  const m = msg(night(failedSome, close()));
  assert.deepEqual(m, {
    severity: 'info',
    dedupId: 'night_charge_actuation',
    title: 'Night-charge: force-charge not applied on slot(s) 2, 3 — reserve restored to 16%',
    body: 'Supervised night charge for 2026-11-16 closed with its force-charge not applied on every slot: reserve raised to 50%; '
      + 'force-charge toward ~56.7% was switched ON but did not take effect on slot(s) 2, 3 (the buy above the reserve did not happen on those slot(s)), '
      + 'with no re-issue of the ON; the pool read 49% at the close, against the ~56.7% the evening notice named; the reserve is restored to 16%. '
      + "Delivery vs plan scores in the ledger at tomorrow evening's update.",
  });
  // The same night with no close account: v1.208.0's "completed" under the restore's title, and no close stated.
  assert.deepEqual(msg(night(failedSome)), {
    severity: 'info',
    dedupId: 'night_charge_actuation',
    title: 'Night-charge: reserve restored to 16%',
    body: 'Supervised night charge for 2026-11-16 completed: reserve raised to 50%; '
      + 'force-charge toward ~56.7% was switched ON but did not take effect on slot(s) 2, 3 (the buy above the reserve did not happen on those slot(s)); '
      + "the reserve is restored to 16%. Delivery vs plan scores in the ledger at tomorrow evening's update.",
  });
});

test('★★★ C1 ran, OFF at the target: "reached ~S% at <clock> and was switched off there", under "completed"', () => {
  const m = msg(night(ran, close({ offReason: 'target', offAtMs: OFF_312, poolPct: 57 })));
  assert.equal(m.title, T_PLAIN);
  assert.equal(m.body, body(COMPLETED,
    'reserve raised to 50%, and force-charge reached ~56.7% at 3:12am and was switched off there; '
    + 'the pool read 57% at the close, against the ~56.7% the evening notice named (~6.2 kWh expected)'));
  // The clock is the OFF's own.
  assert.ok(msg(night(ran, close({ offReason: 'target', offAtMs: OFF_1220, poolPct: 57 }))).body
    .includes('force-charge reached ~56.7% at 12:20am and was switched off there; the pool read 57% at the close'));
});

test('★★★ C1 ran, OFF at the window end: "ran toward ~S% until the window close"', () => {
  const m = msg(night(ran, close({ offReason: 'windowEnd', offAtMs: CLOSE_5, poolPct: 55 })));
  assert.equal(m.title, T_PLAIN);
  assert.equal(m.body, body(COMPLETED,
    'reserve raised to 50%, and force-charge ran toward ~56.7% until the window close; '
    + 'the pool read 55% at the close, against the ~56.7% the evening notice named (~6.2 kWh expected)'));
  // The window end needs no clock: the same words with no OFF time on the record.
  assert.equal(msg(night(ran, close({ offReason: 'windowEnd', offAtMs: null, poolPct: 55 }))).body, m.body);
});

test('★★★ C1 ran, no OFF reason on the record: "ran toward ~S%", and no clock', () => {
  const m = msg(night(ran, close({ poolPct: 55 })));
  assert.equal(m.title, T_PLAIN);
  assert.equal(m.body, body(COMPLETED,
    'reserve raised to 50%, and force-charge ran toward ~56.7%; '
    + 'the pool read 55% at the close, against the ~56.7% the evening notice named (~6.2 kWh expected)'));
  // A time with no reason names nothing.
  assert.equal(msg(night(ran, close({ poolPct: 55, offAtMs: OFF_230 }))).body, m.body);
});

test('★★★ C1 the OFF reasons held below are the words function\'s own cases (notify.ts forceChargeOffWords)', () => {
  const src = sliceOf(NOTIFY, 'function forceChargeOffWords(');
  const cases = Object.fromEntries([...src.matchAll(/case '([A-Za-z]+)': return '([^']+)';/g)].map((m) => [m[1], m[2]]));
  assert.deepEqual(cases, OFF_WORDS);
  assert.equal(src.split('case ').length - 1, Object.keys(OFF_WORDS).length, 'no case the pattern above does not read');
  assert.ok(src.includes('    default: return reason;\n'));
});

test('★★★ C1 ran, any other OFF with its time: "ran toward ~S% until <clock> (switched off: <words>)"', () => {
  let n = 0;
  for (const [reason, words] of Object.entries(OFF_WORDS)) {
    if (reason === 'target') continue; // with its time: "reached", above
    const m = msg(night(ran, close({ offReason: reason, offAtMs: OFF_230, poolPct: 55 })));
    assert.equal(m.title, T_PLAIN, reason);
    assert.equal(m.body, body(COMPLETED,
      `reserve raised to 50%, and force-charge ran toward ~56.7% until 2:30am (switched off: ${words}); `
      + 'the pool read 55% at the close, against the ~56.7% the evening notice named (~6.2 kWh expected)'), reason);
    n++;
  }
  assert.equal(n, 7);
  // One of them in full, with no table between the test and the words.
  assert.equal(msg(night(ran, close({ offReason: 'maxRun', offAtMs: OFF_230, poolPct: 55 }))).body,
    'Supervised night charge for 2026-11-16 completed: reserve raised to 50%, and force-charge ran toward ~56.7% until 2:30am '
    + '(switched off: the run backstop); the pool read 55% at the close, against the ~56.7% the evening notice named (~6.2 kWh expected); '
    + "the reserve is restored to 16%. Delivery vs plan scores in the ledger at tomorrow evening's update.");
});

test('★★★ C1 ran, any other OFF with no time on the record: "until before the window close (switched off: <words>)"', () => {
  let n = 0;
  for (const [reason, words] of Object.entries(OFF_WORDS)) {
    // 'target' included: with no clock there is no "reached ~S% at <clock>", and the reason is still said.
    const m = msg(night(ran, close({ offReason: reason, offAtMs: null, poolPct: 55 })));
    assert.equal(m.title, T_PLAIN, reason);
    assert.equal(m.body, body(COMPLETED,
      `reserve raised to 50%, and force-charge ran toward ~56.7% until before the window close (switched off: ${words}); `
      + 'the pool read 55% at the close, against the ~56.7% the evening notice named (~6.2 kWh expected)'), reason);
    n++;
  }
  assert.equal(n, 8);
});

test('★★★ C1 a verified night counts its ON re-issues: "(after one re-issue of the ON)", "(after 2 re-issues of the ON)"', () => {
  assert.equal(msg(night(ran, close({ offReason: 'target', offAtMs: OFF_312, poolPct: 57, onReissues: 1 }))).body, body(COMPLETED,
    'reserve raised to 50%, and force-charge reached ~56.7% at 3:12am and was switched off there (after one re-issue of the ON); '
    + 'the pool read 57% at the close, against the ~56.7% the evening notice named (~6.2 kWh expected)'));
  assert.equal(msg(night(ran, close({ offReason: 'windowEnd', offAtMs: CLOSE_5, poolPct: 55, onReissues: 2 }))).body, body(COMPLETED,
    'reserve raised to 50%, and force-charge ran toward ~56.7% until the window close (after 2 re-issues of the ON); '
    + 'the pool read 55% at the close, against the ~56.7% the evening notice named (~6.2 kWh expected)'));
  assert.equal(msg(night(ran, close({ poolPct: 55, onReissues: 1 }))).body, body(COMPLETED,
    'reserve raised to 50%, and force-charge ran toward ~56.7% (after one re-issue of the ON); '
    + 'the pool read 55% at the close, against the ~56.7% the evening notice named (~6.2 kWh expected)'));
  // Beside an early OFF the count is said too (how the two brackets sit together is not held here).
  const early = msg(night(ran, close({ offReason: 'maxRun', offAtMs: OFF_230, poolPct: 55, onReissues: 1 }))).body;
  assert.ok(early.includes('force-charge ran toward ~56.7% until 2:30am (switched off: the run backstop)') && early.includes('after one re-issue of the ON'), early);
  // None made: none said, and the title is the restore's whatever the count.
  assert.doesNotMatch(msg(night(ran, close({ poolPct: 55 }))).body, /re-issue/);
  for (const onReissues of [0, 1, 2]) assert.equal(msg(night(ran, close({ onReissues }))).title, T_PLAIN);
});

test('★★★ C1 failed on every slot: "closed without its force-charge", title "force-charge did not take effect", the re-issue said either way', () => {
  const none = msg(night(failedAll, close()));
  assert.equal(none.title, T_NO_EFFECT);
  assert.equal(none.body, body(NO_FORCE_CHARGE,
    'reserve raised to 50%; force-charge toward ~56.7% was switched ON but did not take effect, with no re-issue of the ON; '
    + 'the pool read 49% at the close, against the ~56.7% the evening notice named'));
  const one = msg(night(failedAll, close({ onReissues: 1 })));
  assert.equal(one.title, T_NO_EFFECT);
  assert.equal(one.body, body(NO_FORCE_CHARGE,
    'reserve raised to 50%; force-charge toward ~56.7% was switched ON but did not take effect, after one re-issue of the ON; '
    + 'the pool read 49% at the close, against the ~56.7% the evening notice named'));
  // No expected figure beside a force-charge that did not take effect.
  assert.doesNotMatch(none.body, /kWh expected/);
});

test('★★★ C1 failed on some slots: "not applied on every slot", the slots in the title, the re-issue said either way', () => {
  const none = msg(night(failedSome, close()));
  assert.equal(none.title, T_SLOTS_2_3);
  assert.equal(none.body, body(NOT_EVERY_SLOT, `${FAILED_SOME_WORDS}, with no re-issue of the ON${AT_49}`));
  const one = msg(night(failedSome, close({ onReissues: 1 })));
  assert.equal(one.title, T_SLOTS_2_3);
  assert.equal(one.body, body(NOT_EVERY_SLOT, `${FAILED_SOME_WORDS}, after one re-issue of the ON${AT_49}`));
  // One slot: the list as the record has it.
  const slot2 = msg(night({ kind: 'failed', stopPct: 56.7, expectedLeg: true, partialSlots: [2] }, close({ onReissues: 1 })));
  assert.equal(slot2.title, 'Night-charge: force-charge not applied on slot(s) 2 — reserve restored to 16%');
  assert.equal(slot2.body, body(NOT_EVERY_SLOT,
    'reserve raised to 50%; force-charge toward ~56.7% was switched ON but did not take effect on slot(s) 2 '
    + '(the buy above the reserve did not happen on those slot(s)), after one re-issue of the ON'
    + '; the pool read 49% at the close, against the ~56.7% the evening notice named'));
  // Never "applied in part": a slot left out of the failed list may have been excused at the panel's ceiling.
  for (const m of [none, one, slot2]) assert.doesNotMatch(`${m.title} ${m.body}`, /in part|partly|partial/i);
});

test('★★★ C1 unconfirmed with a target OFF: the stop was read, so "reached", "with no readback showing every slot ON", under "completed"', () => {
  const m = msg(night(unconfirmed, close({ offReason: 'target', offAtMs: OFF_1220, poolPct: 57 })));
  assert.equal(m.title, T_PLAIN);
  assert.equal(m.body, body(COMPLETED,
    'reserve raised to 50%; force-charge reached ~56.7% at 12:20am and was switched off there, with no readback showing every slot ON; '
    + 'the pool read 57% at the close, against the ~56.7% the evening notice named'));
  // Unconfirmed: no expected figure rides it (v1.187.22), and "never confirmed" is not said of a stop that was read.
  assert.doesNotMatch(m.body, /kWh expected|never confirmed/);
});

test('★★★ C1 unconfirmed short of its stop: "closed with its force-charge unconfirmed", title "force-charge not confirmed"', () => {
  const windowEnd = msg(night(unconfirmed, close({ offReason: 'windowEnd', offAtMs: CLOSE_5, poolPct: 52 })));
  assert.equal(windowEnd.title, T_NOT_CONFIRMED);
  assert.equal(windowEnd.body, body(UNCONFIRMED,
    'reserve raised to 50%; force-charge toward ~56.7% was switched ON but the panel never confirmed it; '
    + 'the pool read 52% at the close, against the ~56.7% the evening notice named'));
  const reissued = msg(night(unconfirmed, close({ offReason: 'windowEnd', offAtMs: CLOSE_5, poolPct: 52, onReissues: 1 })));
  assert.equal(reissued.title, T_NOT_CONFIRMED);
  assert.equal(reissued.body, body(UNCONFIRMED,
    'reserve raised to 50%; force-charge toward ~56.7% was switched ON but the panel never confirmed it, after one re-issue of the ON; '
    + 'the pool read 52% at the close, against the ~56.7% the evening notice named'));
  // No OFF on the record at all: the same account.
  const noOff = msg(night(unconfirmed, close({ poolPct: 52 })));
  assert.equal(noOff.title, T_NOT_CONFIRMED);
  assert.equal(noOff.body, windowEnd.body);
});

test('★★★ C1 never started with a start announced: "closed without its force-charge", title "force-charge did not run"', () => {
  const m = msg(night(neverStarted, close()));
  assert.equal(m.title, T_NOT_RUN);
  assert.equal(m.body, body(NO_FORCE_CHARGE,
    'reserve raised to 50%; force-charge toward ~56.7% never started; '
    + 'the pool read 49% at the close, against the ~56.7% the evening notice named'));
  const lost = msg(night(neverStarted, close(), { gridLost: true }));
  assert.equal(lost.title, T_NOT_RUN);
  assert.equal(lost.body, body(NO_FORCE_CHARGE,
    'reserve raised to 50%; force-charge toward ~56.7% never started (the grid read as lost); '
    + 'the pool read 49% at the close, against the ~56.7% the evening notice named'));
  // The record's OFF and re-issue fields say nothing of a force-charge that never started.
  assert.deepEqual(msg(night(neverStarted, close({ offReason: 'windowEnd', offAtMs: CLOSE_5, onReissues: 1 }))), m);
});

test('★★★ C1 never started on a night whose evening notice named a level other than the stop: the words of v1.208.0', () => {
  const old = {
    severity: 'info',
    dedupId: 'night_charge_actuation',
    title: 'Night-charge: reserve restored to 16%',
    body: 'Supervised night charge for 2026-11-16 completed: reserve raised to 50%; force-charge toward ~56.7% never started; '
      + "the reserve is restored to 16%. Delivery vs plan scores in the ledger at tomorrow evening's update.",
  };
  assert.deepEqual(msg(night(neverStarted)), old);
  // The written reserve (the notice expected no start), another level, and no level on the record.
  for (const announcedLevelPct of [50, 56.8, 56.6, 80, 0, null]) {
    assert.deepEqual(msg(night(neverStarted, close({ announcedLevelPct }))), old, String(announcedLevelPct));
    assert.deepEqual(msg(night(neverStarted, close({ announcedLevelPct, poolPct: null, readLate: true }))), old, String(announcedLevelPct));
  }
  const lostOld = msg(night(neverStarted, undefined, { gridLost: true }));
  assert.equal(lostOld.body, body(COMPLETED, 'reserve raised to 50%; force-charge toward ~56.7% never started (the grid read as lost)'));
  assert.deepEqual(msg(night(neverStarted, close({ announcedLevelPct: 50 }), { gridLost: true })), lostOld);
  // Only the never-started night reads the announced level this way: a force-charge that was switched ON states its close
  // beside whatever level the notice named.
  assert.equal(msg(night(failedAll, close({ announcedLevelPct: 50 }))).title, T_NO_EFFECT);
  assert.equal(msg(night(ran, close({ announcedLevelPct: 50, poolPct: 55 }))).body, body(COMPLETED,
    'reserve raised to 50%, and force-charge ran toward ~56.7%; the pool read 55% at the close, against the ~50% the evening notice named (~6.2 kWh expected)'));
});

test('★★★ C1 "reached" names the force-charge stop, whatever level the evening notice named', () => {
  // The notice named the written reserve (it expected no start); the force-charge ran, and its OFF read the pool at the stop.
  const m = msg(night(ran, close({ announcedLevelPct: 50, offReason: 'target', offAtMs: OFF_312, poolPct: 57 })));
  assert.equal(m.title, T_PLAIN);
  assert.equal(m.body, body(COMPLETED,
    'reserve raised to 50%, and force-charge reached ~56.7% at 3:12am and was switched off there; '
    + 'the pool read 57% at the close, against the ~50% the evening notice named (~6.2 kWh expected)'));
  // The same on an ON never read back on every slot, beside a level above the stop.
  assert.equal(msg(night(unconfirmed, close({ announcedLevelPct: 80, offReason: 'target', offAtMs: OFF_1220, poolPct: 57 }))).body, body(COMPLETED,
    'reserve raised to 50%; force-charge reached ~56.7% at 12:20am and was switched off there, with no readback showing every slot ON; '
    + 'the pool read 57% at the close, against the ~80% the evening notice named'));
  // And with no level on the record.
  assert.ok(msg(night(ran, close({ announcedLevelPct: null, offReason: 'target', offAtMs: OFF_312, poolPct: 57 }))).body
    .includes('force-charge reached ~56.7% at 3:12am and was switched off there; the pool read 57% at the close (~6.2 kWh expected)'));
});

/* ══ C2 — the close clause, and the rounding ═══════════════════════════════════════════════════════════ */

test('★★★ C2 the close as read: "the pool read X% at the close, against the ~A% the evening notice named"; no level, no "against"', () => {
  assert.equal(msg(night(ran, close({ poolPct: 55 }))).body, body(COMPLETED,
    'reserve raised to 50%, and force-charge ran toward ~56.7%; the pool read 55% at the close, against the ~56.7% the evening notice named (~6.2 kWh expected)'));
  assert.equal(msg(night(ran, close({ poolPct: 55, announcedLevelPct: null }))).body, body(COMPLETED,
    'reserve raised to 50%, and force-charge ran toward ~56.7%; the pool read 55% at the close (~6.2 kWh expected)'));
  // The same clause closes a flagged account.
  assert.equal(msg(night(failedAll, close({ announcedLevelPct: null }))).body, body(NO_FORCE_CHARGE,
    'reserve raised to 50%; force-charge toward ~56.7% was switched ON but did not take effect, with no re-issue of the ON; the pool read 49% at the close'));
  // Two figures and no verdict, above or below the level.
  for (const poolPct of [40, 49, 56, 57, 90]) {
    assert.doesNotMatch(msg(night(ran, close({ poolPct }))).body, /under|short|below|above|met|missed|outage line/i, String(poolPct));
  }
});

test('★★★ C2 a reading taken too long after the close: "the pool reads X% now, past the window close; the evening notice named ~A%"', () => {
  assert.equal(msg(night(ran, close({ poolPct: 61, readLate: true }))).body, body(COMPLETED,
    'reserve raised to 50%, and force-charge ran toward ~56.7%; the pool reads 61% now, past the window close; the evening notice named ~56.7% (~6.2 kWh expected)'));
  assert.equal(msg(night(ran, close({ poolPct: 61, readLate: true, announcedLevelPct: null }))).body, body(COMPLETED,
    'reserve raised to 50%, and force-charge ran toward ~56.7%; the pool reads 61% now, past the window close (~6.2 kWh expected)'));
  const flagged = msg(night(unconfirmed, close({ poolPct: 61, readLate: true })));
  assert.equal(flagged.title, T_NOT_CONFIRMED);
  assert.equal(flagged.body, body(UNCONFIRMED,
    'reserve raised to 50%; force-charge toward ~56.7% was switched ON but the panel never confirmed it; '
    + 'the pool reads 61% now, past the window close; the evening notice named ~56.7%'));
  // A late reading is never told as the close's.
  assert.doesNotMatch(flagged.body, /at the close/);
});

test('★★★ C2 no reading: "the pool was not read at the close (no fresh panel reading); the evening notice named ~A%"', () => {
  const unread = 'reserve raised to 50%; force-charge toward ~56.7% never started; the pool was not read at the close (no fresh panel reading)';
  assert.equal(msg(night(neverStarted, close({ poolPct: null }))).body, body(NO_FORCE_CHARGE, `${unread}; the evening notice named ~56.7%`));
  assert.equal(msg(night(failedSome, close({ poolPct: null }))).body, body(NOT_EVERY_SLOT,
    `${FAILED_SOME_WORDS}, with no re-issue of the ON; the pool was not read at the close (no fresh panel reading); the evening notice named ~56.7%`));
  assert.equal(msg(night(failedSome, close({ poolPct: null, announcedLevelPct: null }))).body, body(NOT_EVERY_SLOT,
    `${FAILED_SOME_WORDS}, with no re-issue of the ON; the pool was not read at the close (no fresh panel reading)`));
  assert.equal(msg(night(ran, close({ poolPct: null }))).body, body(COMPLETED,
    'reserve raised to 50%, and force-charge ran toward ~56.7%; the pool was not read at the close (no fresh panel reading); '
    + 'the evening notice named ~56.7% (~6.2 kWh expected)'));
  // No reading wins over "late": there is nothing that reads now.
  assert.deepEqual(msg(night(failedSome, close({ poolPct: null, readLate: true }))), msg(night(failedSome, close({ poolPct: null }))));
});

test('★★★ C2 the reading and the levels are stated to one decimal', () => {
  const at = (poolPct: number): string => msg(night(ran, close({ poolPct }))).body;
  assert.ok(at(61.26).includes('; the pool read 61.3% at the close, against the ~56.7% the evening notice named'));
  assert.ok(at(48.94).includes('; the pool read 48.9% at the close,'));
  assert.ok(at(49.96).includes('; the pool read 50% at the close,'));
  assert.ok(at(57).includes('; the pool read 57% at the close,'));
  assert.ok(msg(night(ran, close({ poolPct: 61.26, readLate: true }))).body.includes('; the pool reads 61.3% now, past the window close; the evening notice named ~56.7%'));
  // The stop, in "toward" and in "reached"; the announced level.
  const stop5674: Outcome = { kind: 'ran', stopPct: 56.74, expectedLeg: true };
  assert.ok(msg(night(stop5674, close())).body.includes('force-charge ran toward ~56.7%; the pool read 49% at the close'));
  assert.ok(msg(night(stop5674, close({ offReason: 'target', offAtMs: OFF_312 }))).body.includes('force-charge reached ~56.7% at 3:12am and was switched off there'));
  assert.ok(msg(night(ran, close({ announcedLevelPct: 56.74 }))).body.includes('against the ~56.7% the evening notice named'));
  assert.ok(msg(night(ran, close({ announcedLevelPct: 56.76 }))).body.includes('against the ~56.8% the evening notice named'));
  assert.ok(msg(night(ran, close({ announcedLevelPct: 80.04, poolPct: null }))).body.includes('; the evening notice named ~80%'));
});

test('★★★ C2 "a start was announced" is round1(announced) === round1(stop): 56.74 against 56.7 is one, 56.76 against 56.7 is not', () => {
  const never = (stopPct: number): Outcome => ({ kind: 'neverStarted', stopPct, expectedLeg: true });
  // A 56.74 stop reads ~56.7%, the level the notice named: flagged.
  const same = msg(night(never(56.74), close({ announcedLevelPct: 56.7 })));
  assert.equal(same.title, T_NOT_RUN);
  assert.equal(same.body, body(NO_FORCE_CHARGE,
    'reserve raised to 50%; force-charge toward ~56.7% never started; the pool read 49% at the close, against the ~56.7% the evening notice named'));
  // A 56.76 stop reads ~56.8%: another level was named, and the words of v1.208.0 stand.
  const other = msg(night(never(56.76), close({ announcedLevelPct: 56.7 })));
  assert.equal(other.title, T_PLAIN);
  assert.equal(other.body, body(COMPLETED, 'reserve raised to 50%; force-charge toward ~56.8% never started'));
  assert.deepEqual(other, msg(night(never(56.76))));
  // The announced level rounds the same way.
  assert.equal(msg(night(never(56.7), close({ announcedLevelPct: 56.66 }))).title, T_NOT_RUN);
  assert.deepEqual(msg(night(never(56.7), close({ announcedLevelPct: 56.64 }))), msg(night(never(56.7))));
  // On a force-charge that ran, the two levels are stated as they round, side by side.
  assert.equal(msg(night({ kind: 'ran', stopPct: 56.76, expectedLeg: true }, close())).body, body(COMPLETED,
    'reserve raised to 50%, and force-charge ran toward ~56.8%; the pool read 49% at the close, against the ~56.7% the evening notice named (~6.2 kWh expected)'));
});

/* ══ C3 — with no close account, the text of the releases before, byte for byte ════════════════════════ */

test('★★★ C3 `cost` omitted, null or undefined: the cost-night texts frozen at v1.199.1, byte for byte', () => {
  // The inputs and keys of lineForceChargeAtRisk.test.ts's "word for word as v1.199.1".
  const fcs: Record<string, Outcome> = {
    ran: { kind: 'ran', stopPct: 90, expectedLeg: true },
    neverStarted: { kind: 'neverStarted', stopPct: 80, expectedLeg: true },
    failedPartial: { kind: 'failed', stopPct: 85, expectedLeg: true, partialSlots: [2] },
    failedAll: { kind: 'failed', stopPct: 85, expectedLeg: true, partialSlots: null },
    unconfirmed: { kind: 'unconfirmed', stopPct: 72.8, expectedLeg: null },
    none: { kind: 'none', expectedLeg: false },
  };
  let n = 0;
  for (const [k, fc] of Object.entries(fcs)) for (const closePct of [undefined, 63]) for (const restore of ['readBack', 'acknowledged'] as const) {
    const frozen = COST_TEXTS[`morning.${k}.${closePct ?? 'x'}.${restore}`];
    assert.equal(typeof frozen, 'string', `${k} ${closePct} ${restore}: in the fixture`);
    const input: Input = { day: '2026-10-12', targetPct: 50, restorePct: 16, expectedKwh: 34.88, forceCharge: fc, restore, ...(closePct != null ? { closePoolPct: closePct } : {}) };
    const title = restore === 'acknowledged' ? 'Night-charge: reserve restore to 16% sent' : 'Night-charge: reserve restored to 16%';
    for (const [how, i] of [['omitted', input], ['null', { ...input, cost: null }], ['undefined', { ...input, cost: undefined }]] as Array<[string, Input]>) {
      const m = msg(i);
      assert.equal(m.body, frozen, `${k} ${closePct} ${restore}: cost ${how}`);
      assert.equal(m.title, title, `${k} ${closePct} ${restore}: cost ${how}`);
      assert.equal(m.severity, 'info');
      assert.equal(m.dedupId, 'night_charge_actuation');
    }
    n++;
  }
  assert.equal(n, 24);
});

test('★★★ C3 `cost` omitted, null or undefined: the overnight golden summaries, byte for byte', () => {
  const cases = overnightSummaryCases();
  assert.equal(GOLDEN.summary.length, cases.length);
  assert.ok(cases.length >= 11);
  cases.forEach((c, i) => {
    const g = GOLDEN.summary[i];
    assert.equal(g.name, c.name);
    assert.deepEqual(msg(c.input), g.push, `${c.name}: cost omitted`);
    assert.deepEqual(msg({ ...c.input, cost: null }), g.push, `${c.name}: cost null`);
    assert.deepEqual(msg({ ...c.input, cost: undefined }), g.push, `${c.name}: cost undefined`);
    assert.deepEqual(msg({ ...c.input, restore: 'readBack', cost: null }), g.push, `${c.name}: read back, cost null`);
  });
});

test('★★★ C3 on the shapes no fixture holds (held, standing, acknowledged, the grid read as lost): omitted equals null equals undefined', () => {
  const outcomes: Array<Outcome | null> = [
    null, { kind: 'none', expectedLeg: false }, { kind: 'none', expectedLeg: null }, { kind: 'none', expectedLeg: true },
    ran, { kind: 'ran', stopPct: 80, expectedLeg: null }, { kind: 'ran', stopPct: null, expectedLeg: true },
    neverStarted, failedAll, failedSome, unconfirmed, { kind: 'unconfirmed', stopPct: null, expectedLeg: false },
  ];
  let n = 0;
  let moved = 0;
  for (const fc of outcomes) for (const restore of ['readBack', 'acknowledged'] as const) for (const standing of [false, true])
    for (const expectedKwh of [null, 0, 6.2, 34.88]) for (const gridLost of [false, true]) {
      const input: Input = { day: DAY, targetPct: 50, restorePct: 16, expectedKwh, forceCharge: fc, restore, standing, gridLost };
      const omitted = msg(input);
      assert.deepEqual(msg({ ...input, cost: null }), omitted);
      assert.deepEqual(msg({ ...input, cost: undefined }), omitted);
      // Not vacuous: a close account moves the words of every night it is read on, and of no other.
      const withClose = msg({ ...input, cost: close() });
      const read = fc != null && fc.kind !== 'none' && fc.stopPct != null;
      assert.equal(JSON.stringify(withClose) !== JSON.stringify(omitted), read, JSON.stringify(input));
      if (read) moved++;
      n++;
    }
  assert.equal(n, 12 * 2 * 2 * 4 * 2);
  assert.equal(moved, 6 * 2 * 2 * 4 * 2);
});

/* ══ C4 — where the close account is never read ════════════════════════════════════════════════════════ */

/** Close accounts that would each move the words, and flag the night, were they read. */
const LOUD: NightChargeCostClose[] = [
  close(),
  close({ poolPct: null }),
  close({ poolPct: 61, readLate: true }),
  close({ offReason: 'target', offAtMs: OFF_312, poolPct: 57, onReissues: 1 }),
  close({ offReason: 'maxRun', offAtMs: OFF_230, announcedLevelPct: null }),
];

test('★★★ C4 never read on a night whose input carries a line (linePct): that night\'s own close account stands', () => {
  const costDominant: Outcome[] = [
    { kind: 'ran', stopPct: 90, expectedLeg: true }, { kind: 'neverStarted', stopPct: 90, expectedLeg: true },
    { kind: 'failed', stopPct: 90, expectedLeg: true, partialSlots: null }, { kind: 'failed', stopPct: 90, expectedLeg: true, partialSlots: [2, 3] },
    { kind: 'unconfirmed', stopPct: 90, expectedLeg: true },
  ];
  for (const fc of costDominant) for (const closePoolPct of [62, null]) for (const cost of LOUD) {
    // The announced level is the stop: a never-started night would be flagged, were the account read.
    const c = { ...cost, announcedLevelPct: 90 };
    const line = night(fc, undefined, { linePct: 69.4, closePoolPct });
    const m = msg({ ...line, cost: c });
    assert.deepEqual(m, msg(line), `${fc.kind} ${closePoolPct}`);
    assert.equal(m.title, T_PLAIN);
    assert.doesNotMatch(m.body, /evening notice|re-issue/);
  }
  assert.ok(msg(night({ kind: 'ran', stopPct: 90, expectedLeg: true }, close({ announcedLevelPct: 90 }), { linePct: 69.4, closePoolPct: 62 })).body
    .includes('force-charge ran toward ~90%; the pool read 62% at the close, under the 69.4% outage line'));
  // A line that is no number is no line: the close account is read.
  assert.equal(msg(night(failedAll, close(), { linePct: Number.NaN })).title, T_NO_EFFECT);
  assert.equal(msg(night(failedAll, close(), { linePct: null })).title, T_NO_EFFECT);
});

test('★★★ C4 never read on a night whose outcome carries a line, with or without a stop beside it', () => {
  const line = { askPct: 56, linePct: 55.55 };
  const lineNights: Riding[] = [
    { kind: 'ran', stopPct: null, expectedLeg: true, line: { ...line, offReason: 'windowEnd', offAtMs: CLOSE_5 } },
    { kind: 'neverStarted', stopPct: null, expectedLeg: true, line },
    { kind: 'failed', stopPct: null, expectedLeg: true, partialSlots: [2], line },
    { kind: 'unconfirmed', stopPct: null, expectedLeg: true, line },
    // No record of the add-on's has both; the guard is on the line itself, not on the missing stop.
    { kind: 'ran', stopPct: 56.7, expectedLeg: true, line },
    { kind: 'neverStarted', stopPct: 56.7, expectedLeg: true, line },
    { kind: 'failed', stopPct: 56.7, expectedLeg: true, partialSlots: null, line },
    { kind: 'failed', stopPct: 56.7, expectedLeg: true, partialSlots: [2, 3], line },
    { kind: 'unconfirmed', stopPct: 56.7, expectedLeg: true, line },
  ];
  for (const fc of lineNights) for (const closePoolPct of [52, null]) for (const cost of LOUD) {
    const base = night(fc, undefined, { closePoolPct });
    const m = msg({ ...base, cost });
    assert.deepEqual(m, msg(base), `${fc.kind} ${fc.stopPct} ${closePoolPct}`);
    assert.equal(m.title, T_PLAIN);
    assert.match(m.body, /for the 55\.6% outage line/);
    assert.doesNotMatch(m.body, /evening notice|re-issue/);
  }
});

test('★★★ C4 never read on a night whose outcome carries a line with no usable level: the guard is on the line, not on its level', () => {
  // No record of the add-on's has such a line (forceChargeNightOutcome gives every line a finite level). The builder reads
  // "carries a line" from the line itself, so that night keeps its own account whatever its level field holds.
  let n = 0;
  for (const linePct of [null, undefined]) {
    const line = { askPct: 56, linePct } as unknown as NonNullable<Riding['line']>;
    const lineNights: Riding[] = [
      { kind: 'ran', stopPct: 56.7, expectedLeg: true, line },
      { kind: 'neverStarted', stopPct: 56.7, expectedLeg: true, line },
      { kind: 'failed', stopPct: 56.7, expectedLeg: true, partialSlots: null, line },
      { kind: 'failed', stopPct: 56.7, expectedLeg: true, partialSlots: [2, 3], line },
      { kind: 'unconfirmed', stopPct: 56.7, expectedLeg: true, line },
    ];
    for (const fc of lineNights) for (const cost of LOUD) {
      const base = night(fc);
      const m = built({ ...base, cost }, `${fc.kind} ${String(linePct)}`);
      assert.deepEqual(m, built(base, `${fc.kind} ${String(linePct)}: no close account`), `${fc.kind} ${String(linePct)}`);
      assert.equal(m.title, T_PLAIN, `${fc.kind} ${String(linePct)}`);
      assert.ok(m.body.startsWith(`Supervised night charge for ${DAY} completed: `), `${fc.kind} ${String(linePct)}`);
      assert.doesNotMatch(m.body, /evening notice|re-issue|toward ~/, `${fc.kind} ${String(linePct)}`);
      n++;
    }
  }
  assert.equal(n, 2 * 5 * LOUD.length);
});

test('★★★ C4 never read on a reserve-only night (no force-charge outcome, or kind "none")', () => {
  const none: Array<Outcome | null> = [null, { kind: 'none', expectedLeg: false }, { kind: 'none', expectedLeg: null }, { kind: 'none', expectedLeg: true }];
  for (const fc of none) for (const restore of ['readBack', 'acknowledged'] as const) for (const standing of [false, true]) for (const expectedKwh of [6.2, 0]) for (const cost of LOUD) {
    const base = night(fc, undefined, { restore, standing, expectedKwh });
    assert.deepEqual(msg({ ...base, cost }), msg(base), `${JSON.stringify(fc)} ${restore} ${standing} ${expectedKwh}`);
  }
  assert.deepEqual(msg({ day: DAY, targetPct: 50, restorePct: 16, expectedKwh: 6.2, cost: close() }), {
    severity: 'info', dedupId: 'night_charge_actuation', title: T_PLAIN,
    body: `Supervised night charge for ${DAY} completed: reserve raised to 50% (~6.2 kWh expected) and restored to 16%. ${TAIL}`,
  });
});

test('★★★ C4 never read on a night that ended early (cancelled, grid lost)', () => {
  for (const fc of [ran, neverStarted, failedAll, failedSome, unconfirmed, null]) for (const restore of ['readBack', 'acknowledged'] as const) for (const cost of LOUD) {
    for (const ended of ['cancelled', 'gridLoss'] as const) {
      const base = night(fc, undefined, { ended, restore });
      assert.deepEqual(msg({ ...base, cost }), msg(base), `${fc?.kind} ${ended} ${restore}`);
    }
  }
  assert.deepEqual(msg(night(failedSome, close(), { ended: 'cancelled' })), {
    severity: 'info', dedupId: 'night_charge_actuation', title: 'Night-charge: cancelled — reserve restored to 16%',
    body: `Supervised night charge for ${DAY} was cancelled after the write: the reserve, raised to 50%, is restored to 16% and nothing more is charged tonight.`,
  });
  assert.deepEqual(msg(night(neverStarted, close(), { ended: 'gridLoss' })), {
    severity: 'info', dedupId: 'night_charge_actuation', title: 'Night-charge: stopped (grid lost) — reserve restored to 16%',
    body: `Supervised night charge for ${DAY} stopped: the grid was lost during the window: the reserve, raised to 50%, is restored to 16% and nothing more is charged tonight.`,
  });
  // The window's own close (the default, and said outright) reads it.
  assert.equal(msg(night(failedSome, close(), { ended: 'window' })).title, T_SLOTS_2_3);
});

test('★★★ C4 never read with no finite stop on the outcome', () => {
  for (const stopPct of [null, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const outcomes: Outcome[] = [
      { kind: 'ran', stopPct, expectedLeg: true }, { kind: 'neverStarted', stopPct, expectedLeg: true },
      { kind: 'failed', stopPct, expectedLeg: true, partialSlots: null }, { kind: 'failed', stopPct, expectedLeg: true, partialSlots: [2, 3] },
      { kind: 'unconfirmed', stopPct, expectedLeg: true },
    ];
    for (const fc of outcomes) for (const cost of [...LOUD, close({ announcedLevelPct: stopPct })]) {
      const base = night(fc);
      const m = msg({ ...base, cost });
      assert.deepEqual(m, msg(base), `${fc.kind} ${stopPct}`);
      assert.equal(m.title, T_PLAIN);
      assert.doesNotMatch(`${m.title} ${m.body}`, /NaN|undefined|null|Infinity|evening notice/);
    }
  }
  assert.equal(msg(night({ kind: 'failed', stopPct: null, expectedLeg: true, partialSlots: [2, 3] }, close())).body, body(COMPLETED,
    'reserve raised to 50%; force-charge was switched ON but did not take effect on slot(s) 2, 3 (the buy above the reserve did not happen on those slot(s))'));
});

/* ══ C5 — unusable input ═══════════════════════════════════════════════════════════════════════════════ */

const TOKENS = /NaN|undefined|null|Infinity/;
const unusable = (over: Record<string, unknown>, from: NightChargeCostClose = close()): NightChargeCostClose =>
  ({ ...from, ...over }) as unknown as NightChargeCostClose;
const NON_FINITE = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];

test('★★★ C5 a non-finite pool reading is no reading; a non-finite announced level is no level', () => {
  for (const bad of NON_FINITE) {
    const unread = msg(night(failedSome, unusable({ poolPct: bad })));
    assert.deepEqual(unread, msg(night(failedSome, close({ poolPct: null }))), String(bad));
    assert.ok(unread.body.includes('; the pool was not read at the close (no fresh panel reading); the evening notice named ~56.7%'));
    const noLevel = msg(night(failedSome, unusable({ announcedLevelPct: bad })));
    assert.deepEqual(noLevel, msg(night(failedSome, close({ announcedLevelPct: null }))), String(bad));
    assert.ok(noLevel.body.includes('with no re-issue of the ON; the pool read 49% at the close; the reserve is restored to 16%.'));
    // No level, no start announced: a never-started night keeps the words of v1.208.0.
    assert.deepEqual(msg(night(neverStarted, unusable({ announcedLevelPct: bad }))), msg(night(neverStarted)), String(bad));
    for (const m of [unread, noLevel]) assert.doesNotMatch(`${m.title} ${m.body}`, TOKENS);
  }
});

test('★★★ C5 a non-finite OFF time is no clock: never "at NaN", and a verified night still says what switched it off', () => {
  for (const bad of NON_FINITE) {
    const target = msg(night(ran, unusable({ offReason: 'target', offAtMs: bad, poolPct: 57 })));
    assert.deepEqual(target, msg(night(ran, close({ offReason: 'target', offAtMs: null, poolPct: 57 }))), String(bad));
    assert.ok(target.body.includes('force-charge ran toward ~56.7% until before the window close (switched off: it reached its target); the pool read 57% at the close'));
    const backstop = msg(night(ran, unusable({ offReason: 'maxRun', offAtMs: bad })));
    assert.ok(backstop.body.includes('force-charge ran toward ~56.7% until before the window close (switched off: the run backstop); the pool read 49% at the close'));
    for (const fc of [ran, failedAll, failedSome, unconfirmed, neverStarted]) for (const offReason of ['target', 'windowEnd', 'maxRun', null]) {
      const m = msg(night(fc, unusable({ offReason, offAtMs: bad })));
      assert.doesNotMatch(`${m.title} ${m.body}`, TOKENS, `${fc.kind} ${offReason} ${bad}`);
      assert.doesNotMatch(m.body, /\d(am|pm)/, `${fc.kind} ${offReason} ${bad}: no clock`);
    }
  }
});

test('★★★ C5 an unusable re-issue count (NaN, negative, fractional, not a number) counts no re-issue on a night that says one only where made', () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, -0.5, 1.5, '1', null, undefined]) {
    assert.deepEqual(msg(night(ran, unusable({ onReissues: bad, offReason: 'windowEnd', offAtMs: CLOSE_5 }))),
      msg(night(ran, close({ offReason: 'windowEnd', offAtMs: CLOSE_5 }))), String(bad));
    assert.deepEqual(msg(night(unconfirmed, unusable({ onReissues: bad }))), msg(night(unconfirmed, close())), String(bad));
    assert.doesNotMatch(msg(night(ran, unusable({ onReissues: bad }))).body, /re-issue/, String(bad));
    // A failed night says the count either way; with no usable count its words are not held here (reported), only that it prints no token.
    for (const fc of [failedAll, failedSome]) {
      const m = msg(night(fc, unusable({ onReissues: bad })));
      assert.doesNotMatch(`${m.title} ${m.body}`, TOKENS, `${fc.kind} ${bad}`);
      const said = /(\S+) re-issues? of the ON/.exec(m.body);
      assert.ok(said == null || /^(no|one|[2-9]|[1-9]\d+)$/.test(said[1]), `${fc.kind} ${bad}: ${m.body}`);
    }
  }
});

test('★★★ C5 an OFF reason the words function does not know is still an early OFF with its clock; a close account with no fields throws nothing', () => {
  const m = msg(night(ran, unusable({ offReason: 'someNewReason', offAtMs: OFF_230 })));
  assert.equal(m.title, T_PLAIN);
  assert.ok(m.body.startsWith(`Supervised night charge for ${DAY} completed: reserve raised to 50%, and force-charge ran toward ~56.7% until 2:30am (switched off: `), m.body);
  assert.ok(m.body.endsWith(`; the pool read 49% at the close, against the ~56.7% the evening notice named (~6.2 kWh expected); ${RESTORED}${TAIL}`), m.body);
  assert.doesNotMatch(`${m.title} ${m.body}`, TOKENS);
  for (const fc of [ran, neverStarted, failedAll, failedSome, unconfirmed]) {
    for (const cost of [{}, { poolPct: 49 }, { announcedLevelPct: 56.7 }, { offReason: 'target' }, { onReissues: 1 }]) {
      const out = built(night(fc, cost as unknown as NightChargeCostClose), `${fc.kind} ${JSON.stringify(cost)}`);
      assert.doesNotMatch(`${out.title} ${out.body}`, TOKENS, `${fc.kind} ${JSON.stringify(cost)}`);
    }
  }
  // An empty partial-slot list (no record of the add-on's has one: partialForceChargeOnFailureSlots gives null): its words name no slot
  // and are not held here (reported); it throws nothing and prints no token.
  const empty = msg(night({ kind: 'failed', stopPct: 56.7, expectedLeg: true, partialSlots: [] }, close()));
  assert.doesNotMatch(`${empty.title} ${empty.body}`, TOKENS);
  assert.ok(empty.title.endsWith(' — reserve restored to 16%'));
});

test('★★★ C5 the sweep: every outcome against every unusable field, one at a time and all at once — no throw, no NaN / undefined / null / Infinity', () => {
  const badNumber: unknown[] = [...NON_FINITE, undefined, null, 'x', '49', {}, [], true];
  const badCount: unknown[] = [...NON_FINITE, -1, -0.5, 1.5, '1', {}, null, undefined, true];
  const badReason: unknown[] = ['someNewReason', undefined];
  const outcomes: Outcome[] = [ran, neverStarted, failedAll, failedSome, unconfirmed, { kind: 'failed', stopPct: 56.7, expectedLeg: true, partialSlots: [] }];
  const bases = [close(), close({ offReason: 'target', offAtMs: OFF_312 }), close({ offReason: 'maxRun', offAtMs: OFF_230, onReissues: 1 }), close({ poolPct: null, readLate: true })];
  const fields: Array<[string, unknown[]]> = [
    ['poolPct', badNumber], ['announcedLevelPct', badNumber], ['offAtMs', badNumber], ['onReissues', badCount], ['offReason', badReason], ['readLate', [undefined, null, 'yes', 1]],
  ];
  let n = 0;
  const check = (fc: Outcome, cost: NightChargeCostClose, over: Partial<Input>, what: string): void => {
    const out = built(night(fc, cost, over), what);
    assert.doesNotMatch(`${out.title} ${out.body}`, TOKENS, what);
    assert.equal(out.severity, 'info', what);
    assert.equal(out.dedupId, 'night_charge_actuation', what);
    n++;
  };
  for (const fc of outcomes) for (const from of bases) for (const over of [{}, { restore: 'acknowledged' as const }, { standing: true }]) {
    for (const [field, values] of fields) for (const v of values) check(fc, unusable({ [field]: v }, from), over, `${fc.kind} ${field}=${String(v)}`);
    for (const bad of NON_FINITE) {
      check(fc, unusable({ poolPct: bad, announcedLevelPct: bad, offAtMs: bad, onReissues: bad }, from), over, `${fc.kind} all=${bad}`);
    }
  }
  assert.equal(n, 6 * 4 * 3 * (10 + 10 + 10 + 11 + 2 + 4 + 3));
});

/* ══ C6 — the flagged title keeps the restore half ═════════════════════════════════════════════════════ */

const FLAGGED: Array<{ name: string; fc: Outcome; cost: NightChargeCostClose; flag: string; lead: string }> = [
  { name: 'never started, a start announced', fc: neverStarted, cost: close(), flag: 'force-charge did not run', lead: NO_FORCE_CHARGE },
  { name: 'failed on every slot', fc: failedAll, cost: close({ onReissues: 1 }), flag: 'force-charge did not take effect', lead: NO_FORCE_CHARGE },
  { name: 'failed on some slots', fc: failedSome, cost: close(), flag: 'force-charge not applied on slot(s) 2, 3', lead: NOT_EVERY_SLOT },
  { name: 'unconfirmed, no target OFF', fc: unconfirmed, cost: close({ offReason: 'windowEnd', offAtMs: CLOSE_5 }), flag: 'force-charge not confirmed', lead: UNCONFIRMED },
];

test('★★★ C6 flagged, the restore sent and not yet read back: "<flag> — reserve restore to 16% sent"', () => {
  assert.equal(msg(night(neverStarted, close(), { restore: 'acknowledged' })).title, 'Night-charge: force-charge did not run — reserve restore to 16% sent');
  assert.equal(msg(night(failedAll, close(), { restore: 'acknowledged' })).title, 'Night-charge: force-charge did not take effect — reserve restore to 16% sent');
  assert.equal(msg(night(failedSome, close(), { restore: 'acknowledged' })).title, 'Night-charge: force-charge not applied on slot(s) 2, 3 — reserve restore to 16% sent');
  assert.equal(msg(night(unconfirmed, close(), { restore: 'acknowledged' })).title, 'Night-charge: force-charge not confirmed — reserve restore to 16% sent');
  assert.equal(msg(night(failedSome, close(), { restore: 'acknowledged' })).body,
    'Supervised night charge for 2026-11-16 closed with its force-charge not applied on every slot: reserve raised to 50%; '
    + 'force-charge toward ~56.7% was switched ON but did not take effect on slot(s) 2, 3 (the buy above the reserve did not happen on those slot(s)), '
    + 'with no re-issue of the ON; the pool read 49% at the close, against the ~56.7% the evening notice named; '
    + 'the restore to 16% was sent (the EcoFlow cloud acknowledged it), and the panel has not read it back yet. '
    + "Delivery vs plan scores in the ledger at tomorrow evening's update.");
  for (const f of FLAGGED) {
    const m = msg(night(f.fc, f.cost, { restore: 'acknowledged' }));
    assert.equal(m.title, `Night-charge: ${f.flag} — reserve restore to 16% sent`, f.name);
    assert.ok(m.body.startsWith(`Supervised night charge for ${DAY} ${f.lead}: reserve raised to 50%; force-charge toward ~56.7% `), f.name);
    assert.ok(m.body.endsWith(`; ${ACKED}${TAIL}`), f.name);
    assert.doesNotMatch(m.body, /is restored to/, f.name);
    // The read-back form, for the same night.
    assert.equal(msg(night(f.fc, f.cost, { restore: 'readBack' })).title, `Night-charge: ${f.flag} — reserve restored to 16%`, f.name);
    assert.deepEqual(msg(night(f.fc, f.cost, { restore: 'readBack' })), msg(night(f.fc, f.cost)), f.name);
  }
});

test('★★★ C6 flagged on a reserve that stood: "<flag> — reserve stood at 50%", and no restore claimed', () => {
  assert.equal(msg(night(neverStarted, close(), { standing: true })).title, 'Night-charge: force-charge did not run — reserve stood at 50%');
  assert.equal(msg(night(failedAll, close(), { standing: true })).title, 'Night-charge: force-charge did not take effect — reserve stood at 50%');
  assert.equal(msg(night(failedSome, close(), { standing: true })).title, 'Night-charge: force-charge not applied on slot(s) 2, 3 — reserve stood at 50%');
  assert.equal(msg(night(unconfirmed, close(), { standing: true })).title, 'Night-charge: force-charge not confirmed — reserve stood at 50%');
  assert.equal(msg(night(failedSome, close(), { standing: true })).body,
    'Supervised night charge for 2026-11-16 closed with its force-charge not applied on every slot: the reserve stood at 50%; '
    + 'force-charge toward ~56.7% was switched ON but did not take effect on slot(s) 2, 3 (the buy above the reserve did not happen on those slot(s)), '
    + 'with no re-issue of the ON; the pool read 49% at the close, against the ~56.7% the evening notice named; no restore was due. '
    + "Delivery vs plan scores in the ledger at tomorrow evening's update.");
  for (const f of FLAGGED) for (const restore of ['readBack', 'acknowledged'] as const) {
    // A stood night has no restore, whatever `restore` and `restorePct` say.
    const m = msg(night(f.fc, f.cost, { standing: true, restore, restorePct: 99 }));
    assert.equal(m.title, `Night-charge: ${f.flag} — reserve stood at 50%`, f.name);
    assert.ok(m.body.startsWith(`Supervised night charge for ${DAY} ${f.lead}: the reserve stood at 50%; force-charge toward ~56.7% `), f.name);
    assert.ok(m.body.endsWith(`; ${STOOD}${TAIL}`), f.name);
    assert.doesNotMatch(`${m.title} ${m.body}`, /restored|restore to|99/, f.name);
  }
});

test('★★★ C6 a flagged account on a record with no day prints "—", as the unflagged summary does', () => {
  for (const f of FLAGGED) {
    const m = msg(night(f.fc, f.cost, { day: null }));
    assert.equal(m.title, `Night-charge: ${f.flag} — reserve restored to 16%`, f.name);
    assert.ok(m.body.startsWith(`Supervised night charge for — ${f.lead}: reserve raised to 50%; force-charge toward ~56.7% `), `${f.name}: ${m.body}`);
    assert.ok(m.body.endsWith(`; ${RESTORED}${TAIL}`), f.name);
    assert.doesNotMatch(`${m.title} ${m.body}`, TOKENS, f.name);
  }
  assert.equal(msg(night(failedSome, close(), { day: null })).body,
    'Supervised night charge for — closed with its force-charge not applied on every slot: reserve raised to 50%; '
    + 'force-charge toward ~56.7% was switched ON but did not take effect on slot(s) 2, 3 (the buy above the reserve did not happen on those slot(s)), '
    + 'with no re-issue of the ON; the pool read 49% at the close, against the ~56.7% the evening notice named; the reserve is restored to 16%. '
    + "Delivery vs plan scores in the ledger at tomorrow evening's update.");
  // The unflagged account of the same record, for the same day words.
  assert.ok(msg(night(ran, close({ poolPct: 55 }), { day: null })).body
    .startsWith('Supervised night charge for — completed: reserve raised to 50%, and force-charge ran toward ~56.7%; the pool read 55% at the close'));
});

test('★★★ C6 the reserve\'s own words and the expected figure ride the close account unchanged', () => {
  const reached = close({ offReason: 'target', offAtMs: OFF_312, poolPct: 57 });
  const reachedWords = 'force-charge reached ~56.7% at 3:12am and was switched off there; the pool read 57% at the close, against the ~56.7% the evening notice named';
  // A reserve that stood, under the plain standing title.
  const stood = msg(night(ran, reached, { standing: true }));
  assert.equal(stood.title, 'Night-charge: reserve stood at 50%');
  assert.equal(stood.body, body(COMPLETED, `the reserve stood at 50%, and ${reachedWords} (~6.2 kWh expected)`, STOOD));
  // A night expected to charge nothing: the reserve was a floor, and no figure is stated.
  const held = msg(night(ran, reached, { expectedKwh: 0 }));
  assert.equal(held.title, T_PLAIN);
  assert.equal(held.body, body(COMPLETED, `the reserve was held at 50% overnight as a floor (no charge was expected), and ${reachedWords}`));
  // The restore sent, not read back.
  const acked = msg(night(ran, reached, { restore: 'acknowledged' }));
  assert.equal(acked.title, 'Night-charge: reserve restore to 16% sent');
  assert.equal(acked.body, body(COMPLETED, `reserve raised to 50%, and ${reachedWords} (~6.2 kWh expected)`, ACKED));
  // The figure rides only an account of the legs it counts (v1.187.22): none beside a figure that counts no force-charge leg, or none at all.
  for (const [fc, over] of [
    [{ kind: 'ran', stopPct: 56.7, expectedLeg: false }, {}], [{ kind: 'ran', stopPct: 56.7, expectedLeg: null }, {}], [ran, { expectedKwh: null }],
  ] as Array<[Outcome, Partial<Input>]>) {
    assert.equal(msg(night(fc, reached, over)).body, body(COMPLETED, `reserve raised to 50%, and ${reachedWords}`), JSON.stringify([fc, over]));
  }
});

/* ══ C7 — the wiring (index.ts is not importable: its source is checked) ═══════════════════════════════ */

test('★★★ C7 index.ts sendRestoreSummary passes `cost` only where the record carries no line: six fields, from the record and the live reading', () => {
  const restore = sliceOf(INDEX, 'function sendRestoreSummary(');
  assert.ok(restore.includes(
    '      cost: lineNight == null ? {\n'
    + '        announcedLevelPct: state.announcedLevelPct, poolPct: freshPoolSocPct(nowMs), readLate: lineCloseReadingLate(state, nowMs),\n'
    + '        offReason: state.forceChargeOffReason, offAtMs: state.forceChargeOffAtMs, onReissues: state.forceChargeOnRetries,\n'
    + '      } : null,\n'), restore);
  // The line is the record's own, read once; a night that carries one keeps its close account (the lines of v1.200.0, unchanged).
  assert.ok(restore.includes('  const lineNight = forceChargeLineNightPct(state);\n'));
  assert.ok(restore.includes('      closePoolPct: lineNight != null ? freshPoolSocPct(nowMs) : null,\n      linePct: lineNight,\n'));
  // One `cost`, in the overnight summary's own call: after the mid-day branch, with no call closed between them.
  assert.equal(restore.split('cost: ').length - 1, 1);
  const call = restore.indexOf('void sendNotification(loadNotifyConfig(), buildNightChargeMorningSummary({');
  const cost = restore.indexOf('      cost: lineNight == null ? {');
  assert.ok(restore.indexOf('if (isMiddayLeg(state)) {') > 0 && restore.indexOf('if (isMiddayLeg(state)) {') < call && call < cost);
  assert.ok(!restore.slice(call, cost).includes('}))'), 'the same call');
  assert.ok(restore.slice(cost).includes('      } : null,\n    })).catch((e: any) => {\n'), 'its last argument');
});

test('★★★ C7 notify.ts: the builder calls costNightAccount once, only where neither the input nor the outcome carries a line, after the early-end return', () => {
  const builder = sliceOf(NOTIFY, 'export function buildNightChargeMorningSummary(');
  assert.ok(builder.includes(
    '    const costAccount = linePct == null && line == null\n'
    + '      ? costNightAccount(o.cost, fc, { reserve, toward, note, restored, failedOn, gridLost: o.gridLost === true }) : null;\n'), builder);
  // What "carries a line" reads: the outcome's line, and the input's linePct ahead of it.
  assert.ok(builder.includes("    const line = 'line' in fc ? fc.line : undefined;\n"));
  assert.ok(builder.includes('    const linePct = o.linePct != null && Number.isFinite(o.linePct) ? o.linePct : line?.linePct ?? null;\n'));
  // One call in the file, one read of the input.
  assert.equal(NOTIFY.split('costNightAccount(').length - 1, 2, 'the declaration and one call');
  assert.equal(builder.split('costNightAccount(').length - 1, 1);
  assert.equal(NOTIFY.split('o.cost').length - 1, 1);
  // A night that ended early has returned before it; a reserve-only night never reaches its branch.
  const early = builder.indexOf("  if (o.ended === 'cancelled' || o.ended === 'gridLoss') {\n");
  const call = builder.indexOf('costNightAccount(o.cost');
  assert.ok(early > 0 && early < call);
  const none = builder.indexOf("  } else if (fc.kind === 'none') {\n");
  const rides = builder.indexOf('  } else {\n', none);
  assert.ok(none > early && rides > none && rides < call, 'in the branch of a force-charge that rode the night');
  // The flag is the account's alone, and the title keeps the restore half.
  assert.equal(builder.split('flagged = ').length - 1, 1);
  assert.ok(builder.includes('      flagged = costAccount.flagged;\n'));
  assert.ok(builder.includes('      title: `Night-charge: ${flagged.title} — ${stood ? `reserve stood at ${raised}` : titleRestore}`,\n'));
  // The account itself declines with no close account or no finite stop, and a never-started night with no start announced.
  const account = sliceOf(NOTIFY, 'function costNightAccount(');
  assert.ok(account.includes('  if (cost == null || fc.stopPct == null || !Number.isFinite(fc.stopPct)) return null;\n'));
  assert.ok(account.includes('  const startAnnounced = announced != null && announced === stop;\n'));
  assert.ok(account.includes("  if (fc.kind === 'neverStarted' && !startAnnounced) return null;\n"));
});

/* ══ C8 — severity and dedupId; the whole surface ══════════════════════════════════════════════════════ */

test('★★★ C8 every flagged shape is the summary\'s own notification: info, night_charge_actuation, four fields', () => {
  let n = 0;
  for (const f of FLAGGED) for (const over of [{}, { restore: 'readBack' as const }, { restore: 'acknowledged' as const }, { standing: true }, { gridLost: true }, { expectedKwh: 0 }, { expectedKwh: null }]) {
    for (const cost of [f.cost, { ...f.cost, poolPct: null }, { ...f.cost, readLate: true }, { ...f.cost, onReissues: 1 }]) {
      const m = msg(night(f.fc, cost, over));
      assert.equal(m.severity, 'info', f.name);
      assert.equal(m.dedupId, 'night_charge_actuation', f.name);
      assert.deepEqual(Object.keys(m).sort(), ['body', 'dedupId', 'severity', 'title'], f.name);
      assert.ok(m.title.startsWith(`Night-charge: ${f.flag} — reserve `), `${f.name}: ${m.title}`);
      assert.ok(m.body.startsWith(`Supervised night charge for ${DAY} ${f.lead}: `), `${f.name}: ${m.body}`);
      n++;
    }
  }
  assert.equal(n, 4 * 7 * 4);
  // The unflagged shapes of a close account are the same notification.
  for (const cost of [close(), close({ offReason: 'target', offAtMs: OFF_312 })]) {
    const m = msg(night(ran, cost));
    assert.equal(m.severity, 'info');
    assert.equal(m.dedupId, 'night_charge_actuation');
    assert.deepEqual(Object.keys(m).sort(), ['body', 'dedupId', 'severity', 'title']);
  }
});

test('★★★ C8 the whole surface: one lead, one close clause, a title with its restore half, no doubled space or semicolon', () => {
  const outcomes: Riding[] = [
    ran, { kind: 'ran', stopPct: 80, expectedLeg: null }, neverStarted, failedAll, failedSome,
    { kind: 'failed', stopPct: 56.7, expectedLeg: true, partialSlots: [1] }, unconfirmed,
  ];
  const offs: Array<Pick<NightChargeCostClose, 'offReason' | 'offAtMs'>> = [
    { offReason: null, offAtMs: null }, { offReason: 'windowEnd', offAtMs: CLOSE_5 }, { offReason: 'windowEnd', offAtMs: null },
    ...Object.keys(OFF_WORDS).flatMap((offReason) => [{ offReason, offAtMs: OFF_230 }, { offReason, offAtMs: null }]),
  ];
  const closes: Array<Pick<NightChargeCostClose, 'poolPct' | 'readLate' | 'announcedLevelPct'>> = [56.7, 50, null].flatMap((announcedLevelPct) => [
    { poolPct: 49, readLate: false, announcedLevelPct }, { poolPct: 61.26, readLate: true, announcedLevelPct }, { poolPct: null, readLate: false, announcedLevelPct },
  ]);
  const restores: Array<[Partial<Input>, string, string]> = [
    [{}, 'reserve restored to 16%', RESTORED], [{ restore: 'acknowledged' }, 'reserve restore to 16% sent', ACKED], [{ standing: true }, 'reserve stood at 50%', STOOD],
  ];
  const flagOf: Record<string, RegExp> = {
    [NO_FORCE_CHARGE]: /^force-charge (did not run|did not take effect)$/,
    [NOT_EVERY_SLOT]: /^force-charge not applied on slot\(s\) \d(, \d)*$/,
    [UNCONFIRMED]: /^force-charge not confirmed$/,
  };
  let n = 0;
  for (const fc of outcomes) for (const off of offs) for (const cl of closes) for (const onReissues of [0, 1, 2]) for (const [over, half, restored] of restores) for (const expectedKwh of [6.2, 0]) {
    const cost: NightChargeCostClose = { ...off, ...cl, onReissues };
    const m = msg(night(fc, cost, { ...over, expectedKwh }));
    const what = `${JSON.stringify(fc)} ${JSON.stringify(cost)} ${JSON.stringify(over)} ${expectedKwh}`;
    const head = `Supervised night charge for ${DAY} `;
    assert.ok(m.body.startsWith(head) && m.body.endsWith(`; ${restored}${TAIL}`), what);
    const lead = m.body.slice(head.length, m.body.indexOf(': '));
    const started = cl.announcedLevelPct != null && cl.announcedLevelPct === fc.stopPct;
    const reached = off.offReason === 'target' && off.offAtMs != null;
    const expectedLead = fc.kind === 'ran' ? COMPLETED
      : fc.kind === 'neverStarted' ? (started ? NO_FORCE_CHARGE : COMPLETED)
        : fc.kind === 'failed' ? (fc.partialSlots != null ? NOT_EVERY_SLOT : NO_FORCE_CHARGE)
          : reached ? COMPLETED : UNCONFIRMED;
    // An unconfirmed night whose OFF reason is the target with no OFF clock on the record: its lead is not held here (reported).
    if (fc.kind === 'unconfirmed' && off.offReason === 'target' && off.offAtMs == null) assert.ok(lead === COMPLETED || lead === UNCONFIRMED, what);
    else assert.equal(lead, expectedLead, what);
    // The title: the flag where the lead is one, and always the restore half.
    if (lead === COMPLETED) assert.equal(m.title, `Night-charge: ${half}`, what);
    else {
      const t = /^Night-charge: (.+) — (.+)$/.exec(m.title);
      assert.ok(t != null, `${what}: ${m.title}`);
      assert.match(t![1], flagOf[lead], what);
      assert.equal(t![2], half, what);
    }
    // One close clause wherever the account is read (every night here but a never-started one with no start announced).
    const read = !(fc.kind === 'neverStarted' && !started);
    assert.equal(m.body.split('; the pool ').length - 1, read ? 1 : 0, what);
    assert.equal(m.body.includes('evening notice'), read && cl.announcedLevelPct != null, what);
    // A cost night speaks of no outage line, and its words carry no doubled space, semicolon or comma, nor a stray token.
    for (const text of [m.title, m.body]) {
      assert.doesNotMatch(text, / {2}|;;|; ;| ;|,,| ,|\.\.|\( | \)|\(\)|outage line/, what);
      assert.doesNotMatch(text, TOKENS, what);
    }
    n++;
  }
  assert.equal(n, 7 * 19 * 9 * 3 * 3 * 2);
});
