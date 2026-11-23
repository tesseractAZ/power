import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { phxShortClock } from '../src/chargeText.js';
import { buildNightChargeMorningSummary, type NightChargeCostClose } from '../src/notify.js';
import { overnightSummaryCases } from './fixtures/overnightTextCases.js';

/**
 * v1.209.0 — A COST NIGHT'S MORNING SUMMARY STATES ITS CLOSE (notify.ts buildNightChargeMorningSummary `cost`,
 * costNightAccount; index.ts sendRestoreSummary).
 *
 * Until this release a night with no outage line stated no close. On 2026-11-16 a top-up that two of three slots
 * never took closed at 49% against an announced 56.7% under the title "reserve restored to 16%" and the lead
 * "completed". The summary now takes the record's own account of such a night (`cost`): what switched the
 * force-charge off, the pool as read when the account goes, the level the evening notice named, the ON
 * re-issues made, and the slots the ON was not sent to. A night whose force-charge did not run, did not take effect
 * or was never confirmed short of its stop goes under a lead and a title of its own.
 *
 * What is held here, word for word on title and body:
 *  C1 — every row of the account: ran (a target OFF with and without its clock, a window-end OFF, no OFF, every other
 *       OFF reason with and without its clock, one and two re-issues); failed on every slot and on some (0 and 1
 *       re-issues); unconfirmed (a target OFF, a window-end OFF, no OFF); never started (a start announced, with and
 *       without the grid read as lost; a level other than the stop announced: the words of v1.208.0).
 *  C2 — the close clause in its three forms, each with and without an announced level, and the one-decimal rounding
 *       of the reading and of the levels ("a start was announced" is round1(announced) === round1(stop)).
 *  C3 — byte-identity: with `cost` omitted, null or undefined the text is the frozen text of the releases before
 *       (fixtures/lineNightCostTexts.v1199.json, fixtures/overnightTextGolden.json), and omitted equals null on
 *       the shapes no fixture holds.
 *  C4 — `cost` is never read on a night whose record carries a line, on a reserve-only night, on one that ended
 *       early, or with no finite stop on the outcome.
 *  C5 — unusable input (non-finite figures, an unusable re-issue count, an unknown OFF reason, a close account with
 *       no fields) neither throws nor prints NaN, undefined, null or Infinity.
 *  C6 — the flagged title keeps the restore half in each of its three forms.
 *  C7 — the wiring, from source: index.ts passes `cost` only where the record carries no line; the builder calls
 *       costNightAccount only where neither the input nor the outcome carries one.
 *  C8 — severity and dedupId are the summary's own on every flagged shape; the whole surface, swept.
 *  C9 — the corrections to the account (review 1):
 *       - a force-charge that never started is not flagged where the pool is read, in time, at or above the stop (the
 *         reading as read against the stop as armed, neither rounded);
 *       - "at its stop" is the OFF reason 'target' alone, with or without a time: a failed night says the pool read
 *         the stop and the force-charge was switched off there, and one that failed on every slot goes under "ON not
 *         confirmed"; an unconfirmed night keeps its re-issue;
 *       - a failed or unconfirmed night says what switched the force-charge off before the window did;
 *       - an empty failed-slot list is every slot;
 *       - an OFF time the clock cannot print is no time, on every outcome, and nothing throws;
 *       - a re-issue count that is no count says nothing of a re-issue;
 *       - re-issue words are a comma clause, the expected figure rides the charge's own phrase ahead of the close,
 *         and no two brackets stand in a row;
 *       - a slot the ON was not sent to (`leftOutSlots`) is named after the force-charge clause and ahead of the
 *         close, on a night that ran, failed or was never confirmed, and nowhere else.
 *
 * Reported rather than held word for word: an OFF reason that is an empty string or no string (the bracket of an early
 * OFF prints it as it is: empty brackets for '', and its own token for a NaN — the first is exercised for "does not
 * throw" only, the second is not exercised); a left-out list with a slot repeated, out of order or above the panel's
 * three (printed as given); a failed-slot list that holds something other than slot numbers (the builder's own line
 * of v1.187.22 joins it as it is, and throws on a list that is no list).
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
/** A failed-slot list that names no slot (no record of the add-on's has one: partialForceChargeOnFailureSlots gives null). */
const failedEmpty: Riding = { kind: 'failed', stopPct: 56.7, expectedLeg: true, partialSlots: [] };
const unconfirmed: Riding = { kind: 'unconfirmed', stopPct: 56.7, expectedLeg: true };
/** The outcomes of a force-charge that was switched on; and those beside the one that never started. */
const SWITCHED_ON: Riding[] = [ran, failedAll, failedSome, unconfirmed];
const EVERY_KIND: Riding[] = [...SWITCHED_ON, neverStarted];

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
const ON_NOT_CONFIRMED = 'closed with its force-charge ON not confirmed';
/** The whole body: the lead, the night's account, how the reserve was left, the ledger line. */
const body = (lead: string, account: string, restored = RESTORED): string =>
  `Supervised night charge for ${DAY} ${lead}: ${account}; ${restored}${TAIL}`;
/** The whole notification of a written night whose restore read back. */
const whole = (title: string, lead: string, account: string): ReturnType<typeof msg> =>
  ({ severity: 'info', dedupId: 'night_charge_actuation', title, body: body(lead, account) });

const T_PLAIN = 'Night-charge: reserve restored to 16%';
const T_NOT_RUN = 'Night-charge: force-charge did not run — reserve restored to 16%';
const T_NO_EFFECT = 'Night-charge: force-charge did not take effect — reserve restored to 16%';
const T_SLOTS_2_3 = 'Night-charge: force-charge not applied on slot(s) 2, 3 — reserve restored to 16%';
const T_NOT_CONFIRMED = 'Night-charge: force-charge not confirmed — reserve restored to 16%';
const T_ON_NOT_CONFIRMED = 'Night-charge: force-charge ON not confirmed — reserve restored to 16%';

const FAILED_ALL_WORDS = 'reserve raised to 50%; force-charge toward ~56.7% was switched ON but did not take effect';
// On every slot AND at its stop the body says what is on record (the check failed), not that the charge did not happen.
const FAILED_AT_STOP_WORDS = 'reserve raised to 50%; force-charge toward ~56.7% was switched ON and its readback check failed';
const FAILED_SOME_WORDS = 'reserve raised to 50%; force-charge toward ~56.7% was switched ON but did not take effect on slot(s) 2, 3 '
  + '(the buy above the reserve did not happen on those slot(s))';
const UNCONFIRMED_WORDS = 'reserve raised to 50%; force-charge toward ~56.7% was switched ON but the panel never confirmed it';
const NEVER_WORDS = 'reserve raised to 50%; force-charge toward ~56.7% never started';
const AT_49 = '; the pool read 49% at the close, against the ~56.7% the evening notice named';
const AT_57 = '; the pool read 57% at the close, against the ~56.7% the evening notice named';
/** The expected figure, as it rides a force-charge that ran. */
const FIG = ' (~6.2 kWh expected)';
/** The slots the ON was not sent to. */
const leftOut = (slots: string): string => `; slot(s) ${slots} not switched on (named out of the backup pool by the pool alarm)`;
/** The close clause, in its three forms. */
const CLOSE_CLAUSE = /; the pool (read \S+% at the close|reads \S+% now, past the window close|was not read at the close \(no fresh panel reading\))/g;
/** Two brackets in a row: nothing but spaces or punctuation between one's end and the next one's start. */
const TWO_BRACKETS = /\)[\s,;]*\(/;

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
/** Every OFF that ends a force-charge before the window does, for a cause other than its stop. */
const EARLY_OFFS = Object.entries(OFF_WORDS).filter(([reason]) => reason !== 'target');

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
  assert.equal(m.body,
    'Supervised night charge for 2026-11-16 completed: reserve raised to 50%, and force-charge reached ~56.7% at 3:12am and was switched off there '
    + '(~6.2 kWh expected); the pool read 57% at the close, against the ~56.7% the evening notice named; the reserve is restored to 16%. '
    + "Delivery vs plan scores in the ledger at tomorrow evening's update.");
  // The clock is the OFF's own.
  assert.ok(msg(night(ran, close({ offReason: 'target', offAtMs: OFF_1220, poolPct: 57 }))).body
    .includes('force-charge reached ~56.7% at 12:20am and was switched off there (~6.2 kWh expected); the pool read 57% at the close'));
  // The stop reason alone says "reached": with no OFF time on the record, the same words less the clock.
  const noClock = msg(night(ran, close({ offReason: 'target', offAtMs: null, poolPct: 57 })));
  assert.equal(noClock.title, T_PLAIN);
  assert.equal(noClock.body, body(COMPLETED,
    'reserve raised to 50%, and force-charge reached ~56.7% and was switched off there (~6.2 kWh expected); '
    + 'the pool read 57% at the close, against the ~56.7% the evening notice named'));
});

test('★★★ C1 ran, OFF at the window end: "ran toward ~S% until the window close"', () => {
  const m = msg(night(ran, close({ offReason: 'windowEnd', offAtMs: CLOSE_5, poolPct: 55 })));
  assert.equal(m.title, T_PLAIN);
  assert.equal(m.body, body(COMPLETED,
    'reserve raised to 50%, and force-charge ran toward ~56.7% until the window close (~6.2 kWh expected); '
    + 'the pool read 55% at the close, against the ~56.7% the evening notice named'));
  // The window end needs no clock: the same words with no OFF time on the record.
  assert.equal(msg(night(ran, close({ offReason: 'windowEnd', offAtMs: null, poolPct: 55 }))).body, m.body);
});

test('★★★ C1 ran, no OFF reason on the record: "ran toward ~S%", and no clock', () => {
  const m = msg(night(ran, close({ poolPct: 55 })));
  assert.equal(m.title, T_PLAIN);
  assert.equal(m.body, body(COMPLETED,
    'reserve raised to 50%, and force-charge ran toward ~56.7% (~6.2 kWh expected); '
    + 'the pool read 55% at the close, against the ~56.7% the evening notice named'));
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

test('★★★ C1 ran, any other OFF with its time: "ran toward ~S% and was switched off at <clock> (<words>)", the figure ahead of the OFF', () => {
  let n = 0;
  for (const [reason, words] of EARLY_OFFS) {
    const m = msg(night(ran, close({ offReason: reason, offAtMs: OFF_230, poolPct: 55 })));
    assert.equal(m.title, T_PLAIN, reason);
    assert.equal(m.body, body(COMPLETED,
      `reserve raised to 50%, and force-charge ran toward ~56.7% (~6.2 kWh expected) and was switched off at 2:30am (${words}); `
      + 'the pool read 55% at the close, against the ~56.7% the evening notice named'), reason);
    n++;
  }
  assert.equal(n, 7);
  // One of them in full, with no table between the test and the words.
  assert.equal(msg(night(ran, close({ offReason: 'maxRun', offAtMs: OFF_230, poolPct: 55 }))).body,
    'Supervised night charge for 2026-11-16 completed: reserve raised to 50%, and force-charge ran toward ~56.7% (~6.2 kWh expected) '
    + 'and was switched off at 2:30am (the run backstop); the pool read 55% at the close, against the ~56.7% the evening notice named; '
    + "the reserve is restored to 16%. Delivery vs plan scores in the ledger at tomorrow evening's update.");
});

test('★★★ C1 ran, any other OFF with no time on the record: "and was switched off before the window close (<words>)"', () => {
  let n = 0;
  for (const [reason, words] of EARLY_OFFS) {
    const m = msg(night(ran, close({ offReason: reason, offAtMs: null, poolPct: 55 })));
    assert.equal(m.title, T_PLAIN, reason);
    assert.equal(m.body, body(COMPLETED,
      `reserve raised to 50%, and force-charge ran toward ~56.7% (~6.2 kWh expected) and was switched off before the window close (${words}); `
      + 'the pool read 55% at the close, against the ~56.7% the evening notice named'), reason);
    n++;
  }
  assert.equal(n, 7);
  // The stop is no such OFF: with no time it is still "reached", and the words function's text for it is never printed.
  const target = msg(night(ran, close({ offReason: 'target', offAtMs: null, poolPct: 55 }))).body;
  assert.ok(target.includes('force-charge reached ~56.7% and was switched off there (~6.2 kWh expected); the pool read 55% at the close'), target);
  assert.doesNotMatch(target, /it reached its target|before the window close/);
});

test('★★★ C1 a verified night counts its ON re-issues in a comma clause: ", after one re-issue of the ON", ", after 2 re-issues of the ON"', () => {
  assert.equal(msg(night(ran, close({ offReason: 'target', offAtMs: OFF_312, poolPct: 57, onReissues: 1 }))).body, body(COMPLETED,
    'reserve raised to 50%, and force-charge reached ~56.7% at 3:12am and was switched off there, after one re-issue of the ON (~6.2 kWh expected); '
    + 'the pool read 57% at the close, against the ~56.7% the evening notice named'));
  assert.equal(msg(night(ran, close({ offReason: 'windowEnd', offAtMs: CLOSE_5, poolPct: 55, onReissues: 2 }))).body, body(COMPLETED,
    'reserve raised to 50%, and force-charge ran toward ~56.7% until the window close, after 2 re-issues of the ON (~6.2 kWh expected); '
    + 'the pool read 55% at the close, against the ~56.7% the evening notice named'));
  assert.equal(msg(night(ran, close({ poolPct: 55, onReissues: 1 }))).body, body(COMPLETED,
    'reserve raised to 50%, and force-charge ran toward ~56.7%, after one re-issue of the ON (~6.2 kWh expected); '
    + 'the pool read 55% at the close, against the ~56.7% the evening notice named'));
  // Beside an early OFF the count follows the OFF's cause, and the figure stays with the charge's phrase.
  assert.equal(msg(night(ran, close({ offReason: 'maxRun', offAtMs: OFF_230, poolPct: 55, onReissues: 1 }))).body, body(COMPLETED,
    'reserve raised to 50%, and force-charge ran toward ~56.7% (~6.2 kWh expected) and was switched off at 2:30am (the run backstop), '
    + 'after one re-issue of the ON; the pool read 55% at the close, against the ~56.7% the evening notice named'));
  assert.equal(msg(night(ran, close({ offReason: 'maxRun', offAtMs: null, poolPct: 55, onReissues: 2 }))).body, body(COMPLETED,
    'reserve raised to 50%, and force-charge ran toward ~56.7% (~6.2 kWh expected) and was switched off before the window close (the run backstop), '
    + 'after 2 re-issues of the ON; the pool read 55% at the close, against the ~56.7% the evening notice named'));
  // None made: none said, and the title is the restore's whatever the count.
  assert.doesNotMatch(msg(night(ran, close({ poolPct: 55 }))).body, /re-issue/);
  for (const onReissues of [0, 1, 2]) {
    const m = msg(night(ran, close({ onReissues, offReason: 'maxRun', offAtMs: OFF_230 })));
    assert.equal(m.title, T_PLAIN);
    // Never a bracket of its own.
    assert.doesNotMatch(m.body, /\(after /);
  }
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
  // An OFF at the window end says nothing more, with or without its time: nothing ended this force-charge early.
  assert.deepEqual(msg(night(failedAll, close({ offReason: 'windowEnd', offAtMs: CLOSE_5 }))), none);
  assert.deepEqual(msg(night(failedAll, close({ offReason: 'windowEnd' }))), none);
  assert.deepEqual(msg(night(failedAll, close({ offAtMs: OFF_230 }))), none);
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
  // An OFF at the window end says nothing more.
  assert.deepEqual(msg(night(failedSome, close({ offReason: 'windowEnd', offAtMs: CLOSE_5 }))), none);
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
  // A window-end OFF with no time, and a time with no reason: the same.
  assert.deepEqual(msg(night(unconfirmed, close({ offReason: 'windowEnd', poolPct: 52 }))), windowEnd);
  assert.deepEqual(msg(night(unconfirmed, close({ offAtMs: OFF_230, poolPct: 52 }))), windowEnd);
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
  // The record's OFF, re-issue and left-out fields say nothing of a force-charge that never started.
  assert.deepEqual(msg(night(neverStarted, close({ offReason: 'windowEnd', offAtMs: CLOSE_5, onReissues: 1 }))), m);
  assert.deepEqual(msg(night(neverStarted, close({ offReason: 'target', offAtMs: OFF_312, onReissues: 2, leftOutSlots: [1] }))), m);
  assert.deepEqual(msg(night(neverStarted, close({ offReason: 'maxRun', offAtMs: OFF_230 }))), m);
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
    // Whatever the pool reads, and whatever else the account holds.
    assert.deepEqual(msg(night(neverStarted, close({ announcedLevelPct, poolPct: 57 }))), old, String(announcedLevelPct));
    assert.deepEqual(msg(night(neverStarted, close({ announcedLevelPct, offReason: 'target', offAtMs: OFF_312, onReissues: 1, leftOutSlots: [1, 2] }))), old, String(announcedLevelPct));
  }
  const lostOld = msg(night(neverStarted, undefined, { gridLost: true }));
  assert.equal(lostOld.body, body(COMPLETED, 'reserve raised to 50%; force-charge toward ~56.7% never started (the grid read as lost)'));
  assert.deepEqual(msg(night(neverStarted, close({ announcedLevelPct: 50 }), { gridLost: true })), lostOld);
  // Only the never-started night reads the announced level this way: a force-charge that was switched ON states its close
  // beside whatever level the notice named.
  assert.equal(msg(night(failedAll, close({ announcedLevelPct: 50 }))).title, T_NO_EFFECT);
  assert.equal(msg(night(ran, close({ announcedLevelPct: 50, poolPct: 55 }))).body, body(COMPLETED,
    'reserve raised to 50%, and force-charge ran toward ~56.7% (~6.2 kWh expected); the pool read 55% at the close, against the ~50% the evening notice named'));
});

test('★★★ C1 "reached" names the force-charge stop, whatever level the evening notice named', () => {
  // The notice named the written reserve (it expected no start); the force-charge ran, and its OFF read the pool at the stop.
  const m = msg(night(ran, close({ announcedLevelPct: 50, offReason: 'target', offAtMs: OFF_312, poolPct: 57 })));
  assert.equal(m.title, T_PLAIN);
  assert.equal(m.body, body(COMPLETED,
    'reserve raised to 50%, and force-charge reached ~56.7% at 3:12am and was switched off there (~6.2 kWh expected); '
    + 'the pool read 57% at the close, against the ~50% the evening notice named'));
  // The same on an ON never read back on every slot, beside a level above the stop.
  assert.equal(msg(night(unconfirmed, close({ announcedLevelPct: 80, offReason: 'target', offAtMs: OFF_1220, poolPct: 57 }))).body, body(COMPLETED,
    'reserve raised to 50%; force-charge reached ~56.7% at 12:20am and was switched off there, with no readback showing every slot ON; '
    + 'the pool read 57% at the close, against the ~80% the evening notice named'));
  // And with no level on the record.
  assert.equal(msg(night(ran, close({ announcedLevelPct: null, offReason: 'target', offAtMs: OFF_312, poolPct: 57 }))).body, body(COMPLETED,
    'reserve raised to 50%, and force-charge reached ~56.7% at 3:12am and was switched off there (~6.2 kWh expected); the pool read 57% at the close'));
});

/* ══ C2 — the close clause, and the rounding ═══════════════════════════════════════════════════════════ */

test('★★★ C2 the close as read: "the pool read X% at the close, against the ~A% the evening notice named"; no level, no "against"', () => {
  assert.equal(msg(night(ran, close({ poolPct: 55 }))).body, body(COMPLETED,
    'reserve raised to 50%, and force-charge ran toward ~56.7% (~6.2 kWh expected); the pool read 55% at the close, against the ~56.7% the evening notice named'));
  assert.equal(msg(night(ran, close({ poolPct: 55, announcedLevelPct: null }))).body, body(COMPLETED,
    'reserve raised to 50%, and force-charge ran toward ~56.7% (~6.2 kWh expected); the pool read 55% at the close'));
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
    'reserve raised to 50%, and force-charge ran toward ~56.7% (~6.2 kWh expected); the pool reads 61% now, past the window close; the evening notice named ~56.7%'));
  assert.equal(msg(night(ran, close({ poolPct: 61, readLate: true, announcedLevelPct: null }))).body, body(COMPLETED,
    'reserve raised to 50%, and force-charge ran toward ~56.7% (~6.2 kWh expected); the pool reads 61% now, past the window close'));
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
    'reserve raised to 50%, and force-charge ran toward ~56.7% (~6.2 kWh expected); the pool was not read at the close (no fresh panel reading); '
    + 'the evening notice named ~56.7%'));
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
  // The stop, in "toward", in "reached" and in a failed night's "the pool read ~S%"; the announced level.
  const stop5674: Outcome = { kind: 'ran', stopPct: 56.74, expectedLeg: true };
  assert.ok(msg(night(stop5674, close())).body.includes('force-charge ran toward ~56.7% (~6.2 kWh expected); the pool read 49% at the close'));
  assert.ok(msg(night(stop5674, close({ offReason: 'target', offAtMs: OFF_312 }))).body.includes('force-charge reached ~56.7% at 3:12am and was switched off there'));
  assert.ok(msg(night({ kind: 'failed', stopPct: 56.74, expectedLeg: true, partialSlots: null }, close({ offReason: 'target', offAtMs: OFF_312 }))).body
    .includes('; the pool read ~56.7% at 3:12am and the force-charge was switched off there; the pool read 49% at the close'));
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
    'reserve raised to 50%, and force-charge ran toward ~56.8% (~6.2 kWh expected); the pool read 49% at the close, against the ~56.7% the evening notice named'));
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
  close({ leftOutSlots: [1, 2] }),
  close({ offReason: 'target', offAtMs: 1e300, poolPct: 57, leftOutSlots: [3] }),
];
/** Words only a close account that was read can print. */
const ACCOUNT_WORDS = /evening notice|re-issue|not switched on|pool alarm|switched off/;

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
    const m = built({ ...line, cost: c }, `${fc.kind} ${closePoolPct}`);
    assert.deepEqual(m, msg(line), `${fc.kind} ${closePoolPct}`);
    assert.equal(m.title, T_PLAIN);
    assert.doesNotMatch(m.body, ACCOUNT_WORDS);
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
    const m = built({ ...base, cost }, `${fc.kind} ${fc.stopPct} ${closePoolPct}`);
    assert.deepEqual(m, msg(base), `${fc.kind} ${fc.stopPct} ${closePoolPct}`);
    assert.equal(m.title, T_PLAIN);
    assert.match(m.body, /for the 55\.6% outage line/);
    assert.doesNotMatch(m.body, ACCOUNT_WORDS);
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
      assert.doesNotMatch(m.body, /evening notice|re-issue|not switched on|pool alarm|toward ~/, `${fc.kind} ${String(linePct)}`);
      n++;
    }
  }
  assert.equal(n, 2 * 5 * LOUD.length);
});

test('★★★ C4 never read on a reserve-only night (no force-charge outcome, or kind "none")', () => {
  const none: Array<Outcome | null> = [null, { kind: 'none', expectedLeg: false }, { kind: 'none', expectedLeg: null }, { kind: 'none', expectedLeg: true }];
  for (const fc of none) for (const restore of ['readBack', 'acknowledged'] as const) for (const standing of [false, true]) for (const expectedKwh of [6.2, 0]) for (const cost of LOUD) {
    const base = night(fc, undefined, { restore, standing, expectedKwh });
    assert.deepEqual(built({ ...base, cost }, JSON.stringify(fc)), msg(base), `${JSON.stringify(fc)} ${restore} ${standing} ${expectedKwh}`);
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
      assert.deepEqual(built({ ...base, cost }, `${fc?.kind} ${ended}`), msg(base), `${fc?.kind} ${ended} ${restore}`);
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
      const m = built({ ...base, cost }, `${fc.kind} ${stopPct}`);
      assert.deepEqual(m, msg(base), `${fc.kind} ${stopPct}`);
      assert.equal(m.title, T_PLAIN);
      assert.doesNotMatch(`${m.title} ${m.body}`, /NaN|undefined|null|Infinity|evening notice|not switched on/);
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
/** The largest magnitude a Date holds, in ms (notify.ts MAX_DATE_MS). */
const MAX_DATE = 8.64e15;
/** OFF times no clock prints: outside the Date range, or no finite number. */
const NO_CLOCK_TIMES = [1e300, MAX_DATE + 1, -1e300, -MAX_DATE - 1, ...NON_FINITE];
/** Re-issue counts that are no count. */
const NO_COUNTS: unknown[] = [...NON_FINITE, -1, -0.5, 1.5, '1', 'x', null, undefined, {}, true];

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
    assert.ok(target.body.includes('force-charge reached ~56.7% and was switched off there (~6.2 kWh expected); the pool read 57% at the close'), target.body);
    const backstop = msg(night(ran, unusable({ offReason: 'maxRun', offAtMs: bad })));
    assert.ok(backstop.body.includes('force-charge ran toward ~56.7% (~6.2 kWh expected) and was switched off before the window close (the run backstop); the pool read 49% at the close'), backstop.body);
    for (const fc of [ran, failedAll, failedSome, failedEmpty, unconfirmed, neverStarted]) for (const offReason of ['target', 'windowEnd', 'maxRun', null]) {
      const m = msg(night(fc, unusable({ offReason, offAtMs: bad })));
      assert.doesNotMatch(`${m.title} ${m.body}`, TOKENS, `${fc.kind} ${offReason} ${bad}`);
      assert.doesNotMatch(m.body, /\d(am|pm)/, `${fc.kind} ${offReason} ${bad}: no clock`);
    }
  }
});

test('★★★ C5 an unusable re-issue count (NaN, negative, fractional, not a number) says nothing of a re-issue on a night that ran, was never confirmed or never started', () => {
  const offs: Array<Partial<NightChargeCostClose>> = [
    {}, { offReason: 'target', offAtMs: OFF_312, poolPct: 57 }, { offReason: 'windowEnd', offAtMs: CLOSE_5 }, { offReason: 'maxRun', offAtMs: OFF_230 },
  ];
  const kinds: Riding[] = [ran, unconfirmed, neverStarted];
  let n = 0;
  for (const bad of NO_COUNTS) for (const off of offs) for (const fc of kinds) {
    // On these nights a re-issue is said only where one was made: no count reads as none made.
    const m = built(night(fc, unusable({ ...off, onReissues: bad })), `${fc.kind} ${String(bad)}`);
    assert.deepEqual(m, msg(night(fc, close(off))), `${fc.kind} ${String(bad)} ${JSON.stringify(off)}`);
    assert.doesNotMatch(`${m.title} ${m.body}`, /re-issue/, `${fc.kind} ${String(bad)}`);
    assert.doesNotMatch(`${m.title} ${m.body}`, TOKENS, `${fc.kind} ${String(bad)}`);
    n++;
  }
  assert.equal(n, NO_COUNTS.length * 4 * 3);
  // Not vacuous: a count that is one moves those of a force-charge that was switched on.
  for (const fc of [ran, unconfirmed]) assert.match(msg(night(fc, close({ onReissues: 1 }))).body, /, after one re-issue of the ON/);
});

test('★★★ C5 an OFF reason the words function does not know is still an early OFF with its clock; a close account with no fields throws nothing', () => {
  const m = msg(night(ran, unusable({ offReason: 'someNewReason', offAtMs: OFF_230 })));
  assert.equal(m.title, T_PLAIN);
  assert.equal(m.body, body(COMPLETED,
    `reserve raised to 50%, and force-charge ran toward ~56.7% (~6.2 kWh expected) and was switched off at 2:30am (someNewReason)${AT_49}`));
  assert.equal(msg(night(failedAll, unusable({ offReason: 'someNewReason', offAtMs: OFF_230 }))).body, body(NO_FORCE_CHARGE,
    `${FAILED_ALL_WORDS}, with no re-issue of the ON; it was switched off at 2:30am (someNewReason)${AT_49}`));
  assert.equal(msg(night(unconfirmed, unusable({ offReason: 'someNewReason' }))).body, body(UNCONFIRMED,
    `${UNCONFIRMED_WORDS}; it was switched off before the window close (someNewReason)${AT_49}`));
  assert.doesNotMatch(`${m.title} ${m.body}`, TOKENS);
  // A close account with no fields: no reading, no level, no OFF, no count — and nothing said of any of them but the reading.
  const empty = {} as unknown as NightChargeCostClose;
  const unread = '; the pool was not read at the close (no fresh panel reading)';
  assert.deepEqual(built(night(ran, empty), 'ran {}'), whole(T_PLAIN, COMPLETED, `reserve raised to 50%, and force-charge ran toward ~56.7%${FIG}${unread}`));
  assert.deepEqual(built(night(failedAll, empty), 'failed {}'), whole(T_NO_EFFECT, NO_FORCE_CHARGE, `${FAILED_ALL_WORDS}${unread}`));
  assert.deepEqual(built(night(failedSome, empty), 'failed on some {}'), whole(T_SLOTS_2_3, NOT_EVERY_SLOT, `${FAILED_SOME_WORDS}${unread}`));
  assert.deepEqual(built(night(unconfirmed, empty), 'unconfirmed {}'), whole(T_NOT_CONFIRMED, UNCONFIRMED, `${UNCONFIRMED_WORDS}${unread}`));
  // No level on it: a never-started night keeps the words of v1.208.0.
  assert.deepEqual(built(night(neverStarted, empty), 'never started {}'), msg(night(neverStarted)));
  for (const fc of [ran, neverStarted, failedAll, failedSome, failedEmpty, unconfirmed]) {
    for (const cost of [{}, { poolPct: 49 }, { announcedLevelPct: 56.7 }, { offReason: 'target' }, { onReissues: 1 }, { leftOutSlots: [1] }]) {
      const out = built(night(fc, cost as unknown as NightChargeCostClose), `${fc.kind} ${JSON.stringify(cost)}`);
      assert.doesNotMatch(`${out.title} ${out.body}`, TOKENS, `${fc.kind} ${JSON.stringify(cost)}`);
    }
  }
});

test('★★★ C5 the sweep: every outcome against every unusable field, one at a time and all at once — no throw, no NaN / undefined / null / Infinity', () => {
  const badNumber: unknown[] = [...NON_FINITE, undefined, null, 'x', '49', {}, [], true];
  const badTime: unknown[] = [...badNumber, 1e300, MAX_DATE + 1, -1e300, -MAX_DATE - 1];
  const badCount: unknown[] = [...NON_FINITE, -1, -0.5, 1.5, '1', {}, null, undefined, true];
  // An empty string and a reason that is no string print as they are in an early OFF's bracket (reported): these three are held to no throw,
  // and print none of the four tokens; a reason that is itself NaN or Infinity prints its token, and is not in the list.
  const badReason: unknown[] = ['someNewReason', undefined, '', 5, true];
  const badSlots: unknown[] = [null, undefined, [], [0], [-1], [1.5], [Number.NaN], ['1'], [null], '1', 1, {}, true, [1, Number.NaN, 2]];
  const outcomes: Outcome[] = [ran, neverStarted, failedAll, failedSome, unconfirmed, failedEmpty];
  const bases = [close(), close({ offReason: 'target', offAtMs: OFF_312 }), close({ offReason: 'maxRun', offAtMs: OFF_230, onReissues: 1 }), close({ poolPct: null, readLate: true })];
  const fields: Array<[string, unknown[]]> = [
    ['poolPct', badNumber], ['announcedLevelPct', badNumber], ['offAtMs', badTime], ['onReissues', badCount], ['offReason', badReason],
    ['readLate', [undefined, null, 'yes', 1]], ['leftOutSlots', badSlots],
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
      check(fc, unusable({ poolPct: bad, announcedLevelPct: bad, offAtMs: bad, onReissues: bad, leftOutSlots: [bad] }, from), over, `${fc.kind} all=${bad}`);
    }
  }
  assert.equal(n, 6 * 4 * 3 * (10 + 10 + 14 + 11 + 5 + 4 + 14 + 3));
});

/* ══ C6 — the flagged title keeps the restore half ═════════════════════════════════════════════════════ */

const FLAGGED: Array<{ name: string; fc: Outcome; cost: NightChargeCostClose; flag: string; lead: string }> = [
  { name: 'never started, a start announced', fc: neverStarted, cost: close(), flag: 'force-charge did not run', lead: NO_FORCE_CHARGE },
  { name: 'failed on every slot', fc: failedAll, cost: close({ onReissues: 1 }), flag: 'force-charge did not take effect', lead: NO_FORCE_CHARGE },
  { name: 'failed on every slot, at its stop', fc: failedAll, cost: close({ offReason: 'target', offAtMs: OFF_312 }), flag: 'force-charge ON not confirmed', lead: ON_NOT_CONFIRMED },
  { name: 'failed on some slots', fc: failedSome, cost: close(), flag: 'force-charge not applied on slot(s) 2, 3', lead: NOT_EVERY_SLOT },
  { name: 'unconfirmed, no target OFF', fc: unconfirmed, cost: close({ offReason: 'windowEnd', offAtMs: CLOSE_5 }), flag: 'force-charge not confirmed', lead: UNCONFIRMED },
];

test('★★★ C6 flagged, the restore sent and not yet read back: "<flag> — reserve restore to 16% sent"', () => {
  assert.equal(msg(night(neverStarted, close(), { restore: 'acknowledged' })).title, 'Night-charge: force-charge did not run — reserve restore to 16% sent');
  assert.equal(msg(night(failedAll, close(), { restore: 'acknowledged' })).title, 'Night-charge: force-charge did not take effect — reserve restore to 16% sent');
  assert.equal(msg(night(failedAll, close({ offReason: 'target', offAtMs: OFF_312 }), { restore: 'acknowledged' })).title, 'Night-charge: force-charge ON not confirmed — reserve restore to 16% sent');
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
  assert.equal(msg(night(failedAll, close({ offReason: 'target', offAtMs: OFF_312 }), { standing: true })).title, 'Night-charge: force-charge ON not confirmed — reserve stood at 50%');
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
    .startsWith('Supervised night charge for — completed: reserve raised to 50%, and force-charge ran toward ~56.7% (~6.2 kWh expected); the pool read 55% at the close'));
});

test('★★★ C6 the reserve\'s own words and the expected figure ride the close account unchanged', () => {
  const reached = close({ offReason: 'target', offAtMs: OFF_312, poolPct: 57 });
  const reachedWords = (fig: string): string => `force-charge reached ~56.7% at 3:12am and was switched off there${fig}${AT_57}`;
  // A reserve that stood, under the plain standing title.
  const stood = msg(night(ran, reached, { standing: true }));
  assert.equal(stood.title, 'Night-charge: reserve stood at 50%');
  assert.equal(stood.body, body(COMPLETED, `the reserve stood at 50%, and ${reachedWords(' (~6.2 kWh expected)')}`, STOOD));
  // A night expected to charge nothing: the reserve was a floor, and no figure is stated.
  const held = msg(night(ran, reached, { expectedKwh: 0 }));
  assert.equal(held.title, T_PLAIN);
  assert.equal(held.body, body(COMPLETED, `the reserve was held at 50% overnight as a floor (no charge was expected), and ${reachedWords('')}`));
  // The restore sent, not read back.
  const acked = msg(night(ran, reached, { restore: 'acknowledged' }));
  assert.equal(acked.title, 'Night-charge: reserve restore to 16% sent');
  assert.equal(acked.body, body(COMPLETED, `reserve raised to 50%, and ${reachedWords(' (~6.2 kWh expected)')}`, ACKED));
  // The figure rides only an account of the legs it counts (v1.187.22): none beside a figure that counts no force-charge leg, or none at all.
  for (const [fc, over] of [
    [{ kind: 'ran', stopPct: 56.7, expectedLeg: false }, {}], [{ kind: 'ran', stopPct: 56.7, expectedLeg: null }, {}], [ran, { expectedKwh: null }],
  ] as Array<[Outcome, Partial<Input>]>) {
    assert.equal(msg(night(fc, reached, over)).body, body(COMPLETED, `reserve raised to 50%, and ${reachedWords('')}`), JSON.stringify([fc, over]));
  }
});

/* ══ C7 — the wiring (index.ts is not importable: its source is checked) ═══════════════════════════════ */

test('★★★ C7 index.ts sendRestoreSummary passes `cost` only where the record carries no line: seven fields, from the record and the live reading', () => {
  const restore = sliceOf(INDEX, 'function sendRestoreSummary(');
  assert.ok(restore.includes(
    '      cost: lineNight == null ? {\n'
    + '        announcedLevelPct: state.announcedLevelPct, poolPct: freshPoolSocPct(nowMs), readLate: lineCloseReadingLate(state, nowMs),\n'
    + '        offReason: state.forceChargeOffReason, offAtMs: state.forceChargeOffAtMs, onReissues: state.forceChargeOnRetries,\n'
    // The slots the ON was not sent to, from the record's own field (stamped in the ON's write-ahead persist).
    + '        leftOutSlots: state.forceChargeLeftOutSlots, // v1.209.0 — the slots the ON was not sent to (the pool alarm named their Core out of the pool)\n'
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
    + '      ? costNightAccount(o.cost, fc, { reserve, toward, note, restored, gridLost: o.gridLost === true }) : null;\n'), builder);
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
  assert.equal(n, 5 * 7 * 4);
  // The unflagged shapes of a close account are the same notification.
  for (const [fc, cost] of [
    [ran, close()], [ran, close({ offReason: 'target', offAtMs: OFF_312 })], [unconfirmed, close({ offReason: 'target', offAtMs: OFF_312 })],
    [neverStarted, close({ poolPct: 57 })],
  ] as Array<[Outcome, NightChargeCostClose]>) {
    const m = msg(night(fc, cost));
    assert.equal(m.severity, 'info');
    assert.equal(m.dedupId, 'night_charge_actuation');
    assert.deepEqual(Object.keys(m).sort(), ['body', 'dedupId', 'severity', 'title']);
    assert.equal(m.title, T_PLAIN);
  }
});

test('★★★ C8 the whole surface: one lead, its title with the restore half, one close clause, each clause in its place, no two brackets in a row, no doubled space or semicolon', () => {
  const outcomes: Riding[] = [
    ran, { kind: 'ran', stopPct: 80, expectedLeg: null }, neverStarted, failedAll, failedSome,
    { kind: 'failed', stopPct: 56.7, expectedLeg: true, partialSlots: [1] }, failedEmpty, unconfirmed,
  ];
  const offs: Array<Pick<NightChargeCostClose, 'offReason' | 'offAtMs'>> = [
    { offReason: null, offAtMs: null }, { offReason: 'windowEnd', offAtMs: CLOSE_5 }, { offReason: 'windowEnd', offAtMs: null },
    ...Object.keys(OFF_WORDS).flatMap((offReason) => [{ offReason, offAtMs: OFF_230 }, { offReason, offAtMs: null }]),
  ];
  const closes: Array<Pick<NightChargeCostClose, 'poolPct' | 'readLate' | 'announcedLevelPct'>> = [56.7, 50, null].flatMap((announcedLevelPct) => [
    { poolPct: 49, readLate: false, announcedLevelPct }, { poolPct: 57, readLate: false, announcedLevelPct },
    { poolPct: 61.26, readLate: true, announcedLevelPct }, { poolPct: null, readLate: false, announcedLevelPct },
  ]);
  const restores: Array<[Partial<Input>, string, string]> = [
    [{}, 'reserve restored to 16%', RESTORED], [{ restore: 'acknowledged' }, 'reserve restore to 16% sent', ACKED], [{ standing: true }, 'reserve stood at 50%', STOOD],
  ];
  const lefts: Array<number[] | null> = [null, [1, 3]];
  const LEFT_1_3 = leftOut('1, 3');
  let n = 0;
  let neverUnflagged = 0;
  for (const fc of outcomes) for (const off of offs) for (const cl of closes) for (const onReissues of [0, 1, 2])
    for (const [over, half, restored] of restores) for (const expectedKwh of [6.2, 0]) for (const leftOutSlots of lefts) {
      const cost: NightChargeCostClose = { ...off, ...cl, onReissues, ...(leftOutSlots != null ? { leftOutSlots } : {}) };
      const m = msg(night(fc, cost, { ...over, expectedKwh }));
      const what = `${JSON.stringify(fc)} ${JSON.stringify(cost)} ${JSON.stringify(over)} ${expectedKwh}`;
      const head = `Supervised night charge for ${DAY} `;
      assert.ok(m.body.startsWith(head) && m.body.endsWith(`; ${restored}${TAIL}`), what);
      const lead = m.body.slice(head.length, m.body.indexOf(': '));
      // The account is read on every night here but a never-started one with no start announced.
      const started = cl.announcedLevelPct != null && cl.announcedLevelPct === fc.stopPct;
      const read = !(fc.kind === 'neverStarted' && !started);
      /** A force-charge that was switched on, with its account read. */
      const switchedOn = read && fc.kind !== 'neverStarted';
      const atStop = off.offReason === 'target';
      const early = off.offReason != null && off.offReason !== 'windowEnd' && !atStop;
      const atOrAbove = cl.poolPct != null && !cl.readLate && cl.poolPct >= fc.stopPct!;
      const flag: [string, string] | null = !read || fc.kind === 'ran' ? null
        : fc.kind === 'neverStarted' ? (atOrAbove ? null : [NO_FORCE_CHARGE, 'force-charge did not run'])
          : fc.kind === 'failed'
            ? (fc.partialSlots != null && fc.partialSlots.length > 0 ? [NOT_EVERY_SLOT, `force-charge not applied on slot(s) ${fc.partialSlots.join(', ')}`]
              : atStop ? [ON_NOT_CONFIRMED, 'force-charge ON not confirmed'] : [NO_FORCE_CHARGE, 'force-charge did not take effect'])
            : atStop ? null : [UNCONFIRMED, 'force-charge not confirmed'];
      if (read && fc.kind === 'neverStarted' && flag == null) neverUnflagged++;
      assert.equal(lead, flag != null ? flag[0] : COMPLETED, what);
      // The title: the flag where the lead is one, and always the restore half.
      assert.equal(m.title, flag != null ? `Night-charge: ${flag[1]} — ${half}` : `Night-charge: ${half}`, what);
      // One close clause wherever the account is read, and the announced level beside it where the record has one.
      assert.equal((m.body.match(CLOSE_CLAUSE) ?? []).length, read ? 1 : 0, what);
      assert.equal(m.body.includes('evening notice'), read && cl.announcedLevelPct != null, what);
      // One clock: that of an OFF that ended a switched-on force-charge at its stop or before the window did.
      assert.equal((m.body.match(/\d(am|pm)/g) ?? []).length, switchedOn && off.offAtMs != null && (atStop || early) ? 1 : 0, what);
      assert.equal(m.body.includes('before the window close'), switchedOn && early && off.offAtMs == null, what);
      // The re-issue: counted where made, its absence said on a failed night, in a comma clause.
      const said = !switchedOn ? null : onReissues === 1 ? ', after one re-issue of the ON' : onReissues === 2 ? ', after 2 re-issues of the ON'
        : fc.kind === 'failed' ? ', with no re-issue of the ON' : null;
      assert.equal(m.body.split(' of the ON').length - 1, said != null ? 1 : 0, what);
      if (said != null) assert.ok(m.body.includes(said), what);
      // The slots the ON was not sent to: after the force-charge's clause, with the close clause straight after.
      assert.equal(m.body.split('not switched on').length - 1, switchedOn && leftOutSlots != null ? 1 : 0, what);
      if (switchedOn && leftOutSlots != null) assert.ok(m.body.slice(m.body.indexOf(LEFT_1_3) + LEFT_1_3.length).startsWith('; the pool '), what);
      // The expected figure: beside a force-charge that ran with a figure that counts it, on the charge's own phrase.
      const fig = fc.kind === 'ran' && fc.expectedLeg === true && expectedKwh === 6.2;
      assert.equal(m.body.split('kWh expected').length - 1, fig ? 1 : 0, what);
      if (fig) assert.ok(m.body.slice(m.body.indexOf(FIG) + FIG.length).startsWith(early ? ' and was switched off ' : ';'), what);
      // A cost night speaks of no outage line, and its words carry no doubled space, semicolon or comma, two brackets in a row, nor a stray token.
      for (const text of [m.title, m.body]) {
        assert.doesNotMatch(text, / {2}|;;|; ;| ;|,,| ,|\.\.|\( | \)|\(\)|outage line/, what);
        assert.doesNotMatch(text, TWO_BRACKETS, what);
        assert.doesNotMatch(text, /\((after|with no) |switched off: |it reached its target|in part|partly/, what);
        assert.doesNotMatch(text, TOKENS, what);
      }
      n++;
    }
  assert.equal(n, 8 * 19 * 12 * 3 * 3 * 2 * 2);
  // Not vacuous: a never-started night with the pool read at or above its stop went unflagged.
  assert.equal(neverUnflagged, 19 * 1 * 3 * 3 * 2 * 2);
});

/* ══ C9 — the corrections to the account (review 1) ════════════════════════════════════════════════════ */

test('★★★ C9 never started with the pool read at or above the stop: not flagged — "completed" under the restore\'s title', () => {
  const m = msg(night(neverStarted, close({ poolPct: 57 })));
  assert.deepEqual(m, {
    severity: 'info',
    dedupId: 'night_charge_actuation',
    title: 'Night-charge: reserve restored to 16%',
    body: 'Supervised night charge for 2026-11-16 completed: reserve raised to 50%; force-charge toward ~56.7% never started; '
      + 'the pool read 57% at the close, against the ~56.7% the evening notice named; the reserve is restored to 16%. '
      + "Delivery vs plan scores in the ledger at tomorrow evening's update.",
  });
  // The boundary: a reading equal to the stop is at it.
  assert.deepEqual(msg(night(neverStarted, close({ poolPct: 56.7 }))), whole(T_PLAIN, COMPLETED,
    `${NEVER_WORDS}; the pool read 56.7% at the close, against the ~56.7% the evening notice named`));
  // 0.01 under it is under it: flagged, though the reading prints as the level does.
  assert.deepEqual(msg(night(neverStarted, close({ poolPct: 56.69 }))), whole(T_NOT_RUN, NO_FORCE_CHARGE,
    `${NEVER_WORDS}; the pool read 56.7% at the close, against the ~56.7% the evening notice named`));
  // A late reading at or above it is not the close's: flagged.
  for (const poolPct of [56.7, 57, 100]) {
    assert.deepEqual(msg(night(neverStarted, close({ poolPct, readLate: true }))), whole(T_NOT_RUN, NO_FORCE_CHARGE,
      `${NEVER_WORDS}; the pool reads ${poolPct}% now, past the window close; the evening notice named ~56.7%`), String(poolPct));
  }
  // No reading: flagged.
  assert.deepEqual(msg(night(neverStarted, close({ poolPct: null }))), whole(T_NOT_RUN, NO_FORCE_CHARGE,
    `${NEVER_WORDS}; the pool was not read at the close (no fresh panel reading); the evening notice named ~56.7%`));
  // A reading that is no finite number is no reading (Infinity is not "at or above"): flagged.
  for (const bad of NON_FINITE) {
    assert.deepEqual(msg(night(neverStarted, unusable({ poolPct: bad }))), msg(night(neverStarted, close({ poolPct: null }))), String(bad));
    assert.deepEqual(msg(night(neverStarted, unusable({ poolPct: bad, readLate: true }))), msg(night(neverStarted, close({ poolPct: null }))), String(bad));
  }
  // The same words either way: only the lead and the title move.
  const flagged = msg(night(neverStarted, close({ poolPct: 56.69 })));
  const plain = msg(night(neverStarted, close({ poolPct: 56.7 })));
  assert.equal(flagged.body.replace(NO_FORCE_CHARGE, COMPLETED), plain.body);
  assert.equal(flagged.title.replace('force-charge did not run — ', ''), plain.title);
});

test('★★★ C9 never started, not flagged: the reading as read against the stop as armed (neither rounded), on every form of the title', () => {
  const never = (stopPct: number): Outcome => ({ kind: 'neverStarted', stopPct, expectedLeg: true });
  const at567 = `${NEVER_WORDS}; the pool read 56.7% at the close, against the ~56.7% the evening notice named`;
  // A 56.74 stop reads ~56.7%; a 56.7 reading is under it, a 56.74 one at it, and both print 56.7%.
  assert.deepEqual(msg(night(never(56.74), close({ poolPct: 56.7 }))), whole(T_NOT_RUN, NO_FORCE_CHARGE, at567));
  assert.deepEqual(msg(night(never(56.74), close({ poolPct: 56.74 }))), whole(T_PLAIN, COMPLETED, at567));
  // A 56.66 stop reads ~56.7% too; a 56.68 reading is above it, a 56.652 one under it (it prints 56.7% as well).
  assert.deepEqual(msg(night(never(56.66), close({ poolPct: 56.68 }))), whole(T_PLAIN, COMPLETED, at567));
  assert.deepEqual(msg(night(never(56.66), close({ poolPct: 56.652 }))), whole(T_NOT_RUN, NO_FORCE_CHARGE, at567));
  // Whole-percent readings, as the panel gives them, either side of a 56.7 stop.
  assert.equal(msg(night(neverStarted, close({ poolPct: 56 }))).title, T_NOT_RUN);
  assert.equal(msg(night(neverStarted, close({ poolPct: 57 }))).title, T_PLAIN);
  // The restore sent, and a reserve that stood: the plain title in each form, the lead "completed".
  const acked = msg(night(neverStarted, close({ poolPct: 57 }), { restore: 'acknowledged' }));
  assert.equal(acked.title, 'Night-charge: reserve restore to 16% sent');
  assert.equal(acked.body, body(COMPLETED, `${NEVER_WORDS}${AT_57}`, ACKED));
  const stood = msg(night(neverStarted, close({ poolPct: 57 }), { standing: true }));
  assert.equal(stood.title, 'Night-charge: reserve stood at 50%');
  assert.equal(stood.body, body(COMPLETED, `the reserve stood at 50%; force-charge toward ~56.7% never started${AT_57}`, STOOD));
  // The grid read as lost is said as on a flagged night; the pool at its stop still leaves the night unflagged.
  const lost = msg(night(neverStarted, close({ poolPct: 57 }), { gridLost: true }));
  assert.equal(lost.title, T_PLAIN);
  assert.equal(lost.body, body(COMPLETED, `reserve raised to 50%; force-charge toward ~56.7% never started (the grid read as lost)${AT_57}`));
  // Nothing else on the account moves it: an OFF, a re-issue or a left-out slot says nothing of a force-charge that never started.
  assert.deepEqual(msg(night(neverStarted, close({ poolPct: 57, offReason: 'maxRun', offAtMs: OFF_230, onReissues: 1, leftOutSlots: [1] }))),
    msg(night(neverStarted, close({ poolPct: 57 }))));
});

test('★★★ C9 failed on every slot with a target OFF: the pool read the stop and the force-charge was switched off there — "ON not confirmed"', () => {
  const m = msg(night(failedAll, close({ offReason: 'target', offAtMs: OFF_312, poolPct: 57 })));
  assert.deepEqual(m, {
    severity: 'info',
    dedupId: 'night_charge_actuation',
    title: 'Night-charge: force-charge ON not confirmed — reserve restored to 16%',
    body: 'Supervised night charge for 2026-11-16 closed with its force-charge ON not confirmed: reserve raised to 50%; '
      + 'force-charge toward ~56.7% was switched ON and its readback check failed, with no re-issue of the ON; '
      + 'the pool read ~56.7% at 3:12am and the force-charge was switched off there; '
      + 'the pool read 57% at the close, against the ~56.7% the evening notice named; the reserve is restored to 16%. '
      + "Delivery vs plan scores in the ledger at tomorrow evening's update.",
  });
  // With no OFF time on the record: the same, less the clock.
  assert.deepEqual(msg(night(failedAll, close({ offReason: 'target', offAtMs: null, poolPct: 57 }))), whole(T_ON_NOT_CONFIRMED, ON_NOT_CONFIRMED,
    `${FAILED_AT_STOP_WORDS}, with no re-issue of the ON; the pool read ~56.7% and the force-charge was switched off there${AT_57}`));
  // A re-issue is said ahead of the stop.
  assert.deepEqual(msg(night(failedAll, close({ offReason: 'target', offAtMs: OFF_312, poolPct: 57, onReissues: 1 }))), whole(T_ON_NOT_CONFIRMED, ON_NOT_CONFIRMED,
    `${FAILED_AT_STOP_WORDS}, after one re-issue of the ON; the pool read ~56.7% at 3:12am and the force-charge was switched off there${AT_57}`));
  // The flag is the stop reason's, whatever the close reads.
  assert.deepEqual(msg(night(failedAll, close({ offReason: 'target', offAtMs: OFF_312 }))), whole(T_ON_NOT_CONFIRMED, ON_NOT_CONFIRMED,
    `${FAILED_AT_STOP_WORDS}, with no re-issue of the ON; the pool read ~56.7% at 3:12am and the force-charge was switched off there${AT_49}`));
  // No expected figure, and never "reached" or "completed" of an ON no readback showed.
  assert.doesNotMatch(`${m.title} ${m.body}`, /kWh expected|reached|completed/);
  // Nor "did not take effect": the pool read its stop, so the body says only that the check failed. On SOME slots the
  // slots' own words stand at the stop too, and away from the stop the every-slot words are the plain ones.
  assert.doesNotMatch(m.body, /did not take effect|did not happen/);
  assert.match(msg(night(failedSome, close({ offReason: 'target', offAtMs: OFF_312 }))).body, /was switched ON but did not take effect on slot\(s\) 2, 3 \(the buy above the reserve did not happen on those slot\(s\)\)/);
  assert.doesNotMatch(msg(night(failedSome, close({ offReason: 'target', offAtMs: OFF_312 }))).body, /readback check failed/);
  for (const offReason of [null, 'windowEnd', 'maxRun', 'gridLoss']) {
    const away = msg(night(failedAll, close({ offReason, offAtMs: offReason == null ? null : OFF_230 }))).body;
    assert.match(away, /was switched ON but did not take effect, with no re-issue of the ON/, String(offReason));
    assert.doesNotMatch(away, /readback check failed/, String(offReason));
  }
});

test('★★★ C9 failed on some slots with a target OFF: the slots stay in the lead and the title, and the stop is said', () => {
  const m = msg(night(failedSome, close({ offReason: 'target', offAtMs: OFF_312, poolPct: 57 })));
  assert.deepEqual(m, {
    severity: 'info',
    dedupId: 'night_charge_actuation',
    title: 'Night-charge: force-charge not applied on slot(s) 2, 3 — reserve restored to 16%',
    body: 'Supervised night charge for 2026-11-16 closed with its force-charge not applied on every slot: reserve raised to 50%; '
      + 'force-charge toward ~56.7% was switched ON but did not take effect on slot(s) 2, 3 (the buy above the reserve did not happen on those slot(s)), '
      + 'with no re-issue of the ON; the pool read ~56.7% at 3:12am and the force-charge was switched off there; '
      + 'the pool read 57% at the close, against the ~56.7% the evening notice named; the reserve is restored to 16%. '
      + "Delivery vs plan scores in the ledger at tomorrow evening's update.",
  });
  assert.deepEqual(msg(night(failedSome, close({ offReason: 'target', offAtMs: null, poolPct: 57 }))), whole(T_SLOTS_2_3, NOT_EVERY_SLOT,
    `${FAILED_SOME_WORDS}, with no re-issue of the ON; the pool read ~56.7% and the force-charge was switched off there${AT_57}`));
  assert.deepEqual(msg(night(failedSome, close({ offReason: 'target', offAtMs: OFF_1220, poolPct: 57, onReissues: 1 }))), whole(T_SLOTS_2_3, NOT_EVERY_SLOT,
    `${FAILED_SOME_WORDS}, after one re-issue of the ON; the pool read ~56.7% at 12:20am and the force-charge was switched off there${AT_57}`));
  // One slot.
  assert.deepEqual(msg(night({ kind: 'failed', stopPct: 56.7, expectedLeg: true, partialSlots: [3] }, close({ offReason: 'target', offAtMs: OFF_312, poolPct: 57 }))), whole(
    'Night-charge: force-charge not applied on slot(s) 3 — reserve restored to 16%', NOT_EVERY_SLOT,
    'reserve raised to 50%; force-charge toward ~56.7% was switched ON but did not take effect on slot(s) 3 (the buy above the reserve did not happen on those slot(s)), '
    + `with no re-issue of the ON; the pool read ~56.7% at 3:12am and the force-charge was switched off there${AT_57}`));
});

test('★★★ C9 failed with any other early OFF: "; it was switched off at <clock> (<words>)", or "before the window close" with no time', () => {
  let n = 0;
  for (const [reason, words] of EARLY_OFFS) {
    assert.deepEqual(msg(night(failedAll, close({ offReason: reason, offAtMs: OFF_230 }))), whole(T_NO_EFFECT, NO_FORCE_CHARGE,
      `${FAILED_ALL_WORDS}, with no re-issue of the ON; it was switched off at 2:30am (${words})${AT_49}`), reason);
    assert.deepEqual(msg(night(failedAll, close({ offReason: reason, offAtMs: null, onReissues: 1 }))), whole(T_NO_EFFECT, NO_FORCE_CHARGE,
      `${FAILED_ALL_WORDS}, after one re-issue of the ON; it was switched off before the window close (${words})${AT_49}`), reason);
    assert.deepEqual(msg(night(failedSome, close({ offReason: reason, offAtMs: OFF_230, onReissues: 1 }))), whole(T_SLOTS_2_3, NOT_EVERY_SLOT,
      `${FAILED_SOME_WORDS}, after one re-issue of the ON; it was switched off at 2:30am (${words})${AT_49}`), reason);
    assert.deepEqual(msg(night(failedSome, close({ offReason: reason, offAtMs: null }))), whole(T_SLOTS_2_3, NOT_EVERY_SLOT,
      `${FAILED_SOME_WORDS}, with no re-issue of the ON; it was switched off before the window close (${words})${AT_49}`), reason);
    n++;
  }
  assert.equal(n, 7);
  // One of them in full.
  assert.equal(msg(night(failedAll, close({ offReason: 'maxRun', offAtMs: OFF_230 }))).body,
    'Supervised night charge for 2026-11-16 closed without its force-charge: reserve raised to 50%; force-charge toward ~56.7% was switched ON '
    + 'but did not take effect, with no re-issue of the ON; it was switched off at 2:30am (the run backstop); '
    + 'the pool read 49% at the close, against the ~56.7% the evening notice named; the reserve is restored to 16%. '
    + "Delivery vs plan scores in the ledger at tomorrow evening's update.");
  // An OFF at the window end, or none, is no early OFF: nothing is said of it.
  for (const fc of [failedAll, failedSome]) for (const off of [{ offReason: 'windowEnd', offAtMs: CLOSE_5 }, { offReason: 'windowEnd', offAtMs: null }, { offReason: null, offAtMs: OFF_230 }]) {
    const m = msg(night(fc, close(off)));
    assert.deepEqual(m, msg(night(fc, close())), `${fc.kind} ${JSON.stringify(off)}`);
    assert.doesNotMatch(m.body, /switched off/);
  }
});

test('★★★ C9 unconfirmed with any other early OFF: still flagged, and it says what switched the force-charge off', () => {
  let n = 0;
  for (const [reason, words] of EARLY_OFFS) {
    assert.deepEqual(msg(night(unconfirmed, close({ offReason: reason, offAtMs: OFF_230 }))), whole(T_NOT_CONFIRMED, UNCONFIRMED,
      `${UNCONFIRMED_WORDS}; it was switched off at 2:30am (${words})${AT_49}`), reason);
    assert.deepEqual(msg(night(unconfirmed, close({ offReason: reason, offAtMs: null }))), whole(T_NOT_CONFIRMED, UNCONFIRMED,
      `${UNCONFIRMED_WORDS}; it was switched off before the window close (${words})${AT_49}`), reason);
    assert.deepEqual(msg(night(unconfirmed, close({ offReason: reason, offAtMs: OFF_230, onReissues: 1 }))), whole(T_NOT_CONFIRMED, UNCONFIRMED,
      `${UNCONFIRMED_WORDS}, after one re-issue of the ON; it was switched off at 2:30am (${words})${AT_49}`), reason);
    n++;
  }
  assert.equal(n, 7);
  // One of them in full.
  assert.equal(msg(night(unconfirmed, close({ offReason: 'gridLoss', offAtMs: OFF_1220, onReissues: 1 }))).body,
    'Supervised night charge for 2026-11-16 closed with its force-charge unconfirmed: reserve raised to 50%; force-charge toward ~56.7% was switched ON '
    + 'but the panel never confirmed it, after one re-issue of the ON; it was switched off at 12:20am (the grid was lost); '
    + 'the pool read 49% at the close, against the ~56.7% the evening notice named; the reserve is restored to 16%. '
    + "Delivery vs plan scores in the ledger at tomorrow evening's update.");
  // Whatever the pool reads at the close: an OFF short of the stop leaves the ON unconfirmed.
  assert.equal(msg(night(unconfirmed, close({ offReason: 'maxRun', offAtMs: OFF_230, poolPct: 90 }))).title, T_NOT_CONFIRMED);
});

test('★★★ C9 unconfirmed at its stop: the re-issue is kept, and the stop reason alone says "reached" (no OFF time needed)', () => {
  const reissued = msg(night(unconfirmed, close({ offReason: 'target', offAtMs: OFF_1220, poolPct: 57, onReissues: 1 })));
  assert.deepEqual(reissued, {
    severity: 'info',
    dedupId: 'night_charge_actuation',
    title: 'Night-charge: reserve restored to 16%',
    body: 'Supervised night charge for 2026-11-16 completed: reserve raised to 50%; force-charge reached ~56.7% at 12:20am and was switched off there, '
      + 'with no readback showing every slot ON, after one re-issue of the ON; '
      + 'the pool read 57% at the close, against the ~56.7% the evening notice named; the reserve is restored to 16%. '
      + "Delivery vs plan scores in the ledger at tomorrow evening's update.",
  });
  assert.deepEqual(msg(night(unconfirmed, close({ offReason: 'target', offAtMs: OFF_1220, poolPct: 57, onReissues: 2 }))), whole(T_PLAIN, COMPLETED,
    'reserve raised to 50%; force-charge reached ~56.7% at 12:20am and was switched off there, with no readback showing every slot ON, '
    + `after 2 re-issues of the ON${AT_57}`));
  // No OFF time on the record: "reached" all the same, under "completed" and the restore's title.
  const noTime = msg(night(unconfirmed, close({ offReason: 'target', offAtMs: null, poolPct: 57 })));
  assert.deepEqual(noTime, whole(T_PLAIN, COMPLETED,
    `reserve raised to 50%; force-charge reached ~56.7% and was switched off there, with no readback showing every slot ON${AT_57}`));
  assert.deepEqual(msg(night(unconfirmed, close({ offReason: 'target', offAtMs: null, poolPct: 57, onReissues: 1 }))), whole(T_PLAIN, COMPLETED,
    `reserve raised to 50%; force-charge reached ~56.7% and was switched off there, with no readback showing every slot ON, after one re-issue of the ON${AT_57}`));
  // Whatever the close reads: the stop reason is the reading.
  assert.equal(msg(night(unconfirmed, close({ offReason: 'target', offAtMs: null, poolPct: null }))).title, T_PLAIN);
  for (const m of [reissued, noTime]) assert.doesNotMatch(`${m.title} ${m.body}`, /never confirmed|unconfirmed|not confirmed|kWh expected/);
});

test('★★★ C9 an empty failed-slot list is every slot: no slot named, no doubled space, the lead and title of a whole failure', () => {
  const m = msg(night(failedEmpty, close()));
  assert.deepEqual(m, {
    severity: 'info',
    dedupId: 'night_charge_actuation',
    title: 'Night-charge: force-charge did not take effect — reserve restored to 16%',
    body: 'Supervised night charge for 2026-11-16 closed without its force-charge: reserve raised to 50%; '
      + 'force-charge toward ~56.7% was switched ON but did not take effect, with no re-issue of the ON; '
      + 'the pool read 49% at the close, against the ~56.7% the evening notice named; the reserve is restored to 16%. '
      + "Delivery vs plan scores in the ledger at tomorrow evening's update.",
  });
  // On every shape of the account it is the null list's night, word for word.
  const shapes: NightChargeCostClose[] = [
    close(), close({ onReissues: 1 }), close({ poolPct: null }), close({ poolPct: 61, readLate: true }), close({ announcedLevelPct: null }),
    close({ offReason: 'target', offAtMs: OFF_312, poolPct: 57 }), close({ offReason: 'target', offAtMs: null }),
    close({ offReason: 'maxRun', offAtMs: OFF_230, onReissues: 1 }), close({ offReason: 'windowEnd', offAtMs: CLOSE_5 }),
    close({ leftOutSlots: [1] }), unusable({ onReissues: Number.NaN }),
  ];
  for (const cost of shapes) for (const over of [{}, { restore: 'acknowledged' as const }, { standing: true }]) {
    const empty = msg(night(failedEmpty, cost, over));
    assert.deepEqual(empty, msg(night(failedAll, cost, over)), JSON.stringify(cost));
    for (const text of [empty.title, empty.body]) {
      assert.doesNotMatch(text, / {2}|slot\(s\) {2}|slot\(s\) \(|on slot|those slot|not applied on|every slot/, JSON.stringify(cost));
    }
  }
  // At its stop it goes under "ON not confirmed", as every-slot does.
  assert.equal(msg(night(failedEmpty, close({ offReason: 'target', offAtMs: OFF_312 }))).title, T_ON_NOT_CONFIRMED);
});

test('★★★ C9 an OFF time the clock cannot print (1e300, 8.64e15 + 1, -1e300, NaN, Infinity) is no time on every outcome: no throw, no clock, the rest of the sentence intact', () => {
  // Each night with no OFF time on the record, word for word; then the same night with each unprintable time.
  const rows: Array<[Riding, string | null, string, string, string]> = [
    [ran, 'target', T_PLAIN, COMPLETED, `reserve raised to 50%, and force-charge reached ~56.7% and was switched off there (~6.2 kWh expected)${AT_49}`],
    [ran, 'maxRun', T_PLAIN, COMPLETED, `reserve raised to 50%, and force-charge ran toward ~56.7% (~6.2 kWh expected) and was switched off before the window close (the run backstop)${AT_49}`],
    [ran, 'windowEnd', T_PLAIN, COMPLETED, `reserve raised to 50%, and force-charge ran toward ~56.7% until the window close (~6.2 kWh expected)${AT_49}`],
    [ran, null, T_PLAIN, COMPLETED, `reserve raised to 50%, and force-charge ran toward ~56.7% (~6.2 kWh expected)${AT_49}`],
    [failedAll, 'target', T_ON_NOT_CONFIRMED, ON_NOT_CONFIRMED, `${FAILED_AT_STOP_WORDS}, with no re-issue of the ON; the pool read ~56.7% and the force-charge was switched off there${AT_49}`],
    [failedAll, 'maxRun', T_NO_EFFECT, NO_FORCE_CHARGE, `${FAILED_ALL_WORDS}, with no re-issue of the ON; it was switched off before the window close (the run backstop)${AT_49}`],
    [failedAll, 'windowEnd', T_NO_EFFECT, NO_FORCE_CHARGE, `${FAILED_ALL_WORDS}, with no re-issue of the ON${AT_49}`],
    [failedAll, null, T_NO_EFFECT, NO_FORCE_CHARGE, `${FAILED_ALL_WORDS}, with no re-issue of the ON${AT_49}`],
    [failedSome, 'target', T_SLOTS_2_3, NOT_EVERY_SLOT, `${FAILED_SOME_WORDS}, with no re-issue of the ON; the pool read ~56.7% and the force-charge was switched off there${AT_49}`],
    [failedSome, 'maxRun', T_SLOTS_2_3, NOT_EVERY_SLOT, `${FAILED_SOME_WORDS}, with no re-issue of the ON; it was switched off before the window close (the run backstop)${AT_49}`],
    [failedSome, 'windowEnd', T_SLOTS_2_3, NOT_EVERY_SLOT, `${FAILED_SOME_WORDS}, with no re-issue of the ON${AT_49}`],
    [failedSome, null, T_SLOTS_2_3, NOT_EVERY_SLOT, `${FAILED_SOME_WORDS}, with no re-issue of the ON${AT_49}`],
    [unconfirmed, 'target', T_PLAIN, COMPLETED, `reserve raised to 50%; force-charge reached ~56.7% and was switched off there, with no readback showing every slot ON${AT_49}`],
    [unconfirmed, 'maxRun', T_NOT_CONFIRMED, UNCONFIRMED, `${UNCONFIRMED_WORDS}; it was switched off before the window close (the run backstop)${AT_49}`],
    [unconfirmed, 'windowEnd', T_NOT_CONFIRMED, UNCONFIRMED, `${UNCONFIRMED_WORDS}${AT_49}`],
    [unconfirmed, null, T_NOT_CONFIRMED, UNCONFIRMED, `${UNCONFIRMED_WORDS}${AT_49}`],
    [neverStarted, 'target', T_NOT_RUN, NO_FORCE_CHARGE, `${NEVER_WORDS}${AT_49}`],
    [neverStarted, 'maxRun', T_NOT_RUN, NO_FORCE_CHARGE, `${NEVER_WORDS}${AT_49}`],
    [neverStarted, 'windowEnd', T_NOT_RUN, NO_FORCE_CHARGE, `${NEVER_WORDS}${AT_49}`],
    [neverStarted, null, T_NOT_RUN, NO_FORCE_CHARGE, `${NEVER_WORDS}${AT_49}`],
  ];
  let n = 0;
  for (const [fc, offReason, title, lead, account] of rows) {
    const want = whole(title, lead, account);
    assert.deepEqual(msg(night(fc, close({ offReason, offAtMs: null }))), want, `${fc.kind} ${offReason}: no time`);
    assert.doesNotMatch(want.body, /\d(am|pm)/);
    // Not a number at all, too: a time kept as text is no time.
    for (const bad of [...NO_CLOCK_TIMES, String(OFF_230), {}, true] as unknown[]) {
      const m = built(night(fc, unusable({ offReason, offAtMs: bad })), `${fc.kind} ${offReason} ${String(bad)}`);
      assert.deepEqual(m, want, `${fc.kind} ${offReason} ${String(bad)}`);
      n++;
    }
  }
  assert.equal(n, 20 * (NO_CLOCK_TIMES.length + 3));
  assert.equal(NO_CLOCK_TIMES.length, 7);
  // Beside a re-issue, a left-out slot and a restore not read back, on a reserve that stood: the same.
  const kinds: Riding[] = [...EVERY_KIND, failedEmpty];
  for (const bad of NO_CLOCK_TIMES) for (const fc of kinds) for (const offReason of ['target', 'maxRun']) {
    for (const over of [{ restore: 'acknowledged' as const }, { standing: true }]) {
      const rest = { offReason, onReissues: 1, leftOutSlots: [2], poolPct: null };
      assert.deepEqual(built(night(fc, unusable({ ...rest, offAtMs: bad }), over), `${fc.kind} ${offReason} ${bad}`), msg(night(fc, close({ ...rest, offAtMs: null }), over)), `${fc.kind} ${offReason} ${bad}`);
    }
  }
});

test('★★★ C9 the largest time a Date holds still prints its clock; one millisecond past it prints none', () => {
  for (const at of [MAX_DATE, -MAX_DATE]) {
    const clock = phxShortClock(at);
    assert.match(clock, /^\d{1,2}(:\d\d)?(am|pm)$/, String(at));
    assert.deepEqual(built(night(ran, close({ offReason: 'target', offAtMs: at })), String(at)), whole(T_PLAIN, COMPLETED,
      `reserve raised to 50%, and force-charge reached ~56.7% at ${clock} and was switched off there (~6.2 kWh expected)${AT_49}`), String(at));
    assert.deepEqual(built(night(ran, close({ offReason: 'maxRun', offAtMs: at })), String(at)), whole(T_PLAIN, COMPLETED,
      `reserve raised to 50%, and force-charge ran toward ~56.7% (~6.2 kWh expected) and was switched off at ${clock} (the run backstop)${AT_49}`), String(at));
    assert.deepEqual(built(night(failedAll, close({ offReason: 'target', offAtMs: at })), String(at)), whole(T_ON_NOT_CONFIRMED, ON_NOT_CONFIRMED,
      `${FAILED_AT_STOP_WORDS}, with no re-issue of the ON; the pool read ~56.7% at ${clock} and the force-charge was switched off there${AT_49}`), String(at));
    assert.deepEqual(built(night(unconfirmed, close({ offReason: 'maxRun', offAtMs: at })), String(at)), whole(T_NOT_CONFIRMED, UNCONFIRMED,
      `${UNCONFIRMED_WORDS}; it was switched off at ${clock} (the run backstop)${AT_49}`), String(at));
  }
  for (const past of [MAX_DATE + 1, -MAX_DATE - 1]) {
    assert.notEqual(past, Math.sign(past) * MAX_DATE, 'one millisecond is representable at this magnitude');
    for (const fc of SWITCHED_ON) for (const offReason of ['target', 'maxRun']) {
      const m = built(night(fc, close({ offReason, offAtMs: past })), `${fc.kind} ${offReason} ${past}`);
      assert.deepEqual(m, msg(night(fc, close({ offReason, offAtMs: null }))), `${fc.kind} ${offReason} ${past}`);
      assert.doesNotMatch(m.body, /\d(am|pm)/, `${fc.kind} ${offReason} ${past}`);
    }
  }
});

test('★★★ C9 a re-issue count that is no count (NaN, -1, 1.5, a string) says nothing of a re-issue on a failed night: neither "after" nor "with no"', () => {
  let n = 0;
  for (const bad of NO_COUNTS) {
    const what = String(bad);
    assert.deepEqual(built(night(failedAll, unusable({ onReissues: bad })), what), whole(T_NO_EFFECT, NO_FORCE_CHARGE, `${FAILED_ALL_WORDS}${AT_49}`), what);
    assert.deepEqual(built(night(failedSome, unusable({ onReissues: bad })), what), whole(T_SLOTS_2_3, NOT_EVERY_SLOT, `${FAILED_SOME_WORDS}${AT_49}`), what);
    assert.deepEqual(built(night(failedEmpty, unusable({ onReissues: bad })), what), whole(T_NO_EFFECT, NO_FORCE_CHARGE, `${FAILED_ALL_WORDS}${AT_49}`), what);
    // The stop, or the early OFF, follows the failure straight away.
    assert.deepEqual(built(night(failedAll, unusable({ onReissues: bad, offReason: 'target', offAtMs: OFF_312, poolPct: 57 })), what), whole(T_ON_NOT_CONFIRMED, ON_NOT_CONFIRMED,
      `${FAILED_AT_STOP_WORDS}; the pool read ~56.7% at 3:12am and the force-charge was switched off there${AT_57}`), what);
    assert.deepEqual(built(night(failedSome, unusable({ onReissues: bad, offReason: 'maxRun', offAtMs: OFF_230 })), what), whole(T_SLOTS_2_3, NOT_EVERY_SLOT,
      `${FAILED_SOME_WORDS}; it was switched off at 2:30am (the run backstop)${AT_49}`), what);
    for (const fc of [failedAll, failedSome, failedEmpty]) for (const from of [close(), close({ offReason: 'target', offAtMs: OFF_312 }), close({ offReason: 'maxRun' }), close({ poolPct: null, leftOutSlots: [1] })]) {
      const m = built(night(fc, unusable({ onReissues: bad }, from)), what);
      assert.doesNotMatch(`${m.title} ${m.body}`, /re-issue|of the ON/, `${fc.kind} ${what}`);
      assert.doesNotMatch(`${m.title} ${m.body}`, TOKENS, `${fc.kind} ${what}`);
      n++;
    }
  }
  assert.equal(n, NO_COUNTS.length * 3 * 4);
  assert.equal(NO_COUNTS.length, 12);
  // A count of zero is a count: none was made, and a failed night says so (negative zero is zero).
  assert.equal(msg(night(failedAll, close({ onReissues: 0 }))).body, body(NO_FORCE_CHARGE, `${FAILED_ALL_WORDS}, with no re-issue of the ON${AT_49}`));
  assert.equal(msg(night(failedAll, close({ onReissues: -0 }))).body, body(NO_FORCE_CHARGE, `${FAILED_ALL_WORDS}, with no re-issue of the ON${AT_49}`));
  assert.equal(msg(night(failedAll, close({ onReissues: 3 }))).body, body(NO_FORCE_CHARGE, `${FAILED_ALL_WORDS}, after 3 re-issues of the ON${AT_49}`));
});

test('★★★ C9 the expected figure rides the charge\'s own phrase on each ran form, ahead of the close clause and of an early OFF', () => {
  const forms: Array<[string, Partial<NightChargeCostClose>, (fig: string) => string]> = [
    ['at its stop', { offReason: 'target', offAtMs: OFF_312 }, (f) => `force-charge reached ~56.7% at 3:12am and was switched off there${f}`],
    ['at its stop, no time', { offReason: 'target' }, (f) => `force-charge reached ~56.7% and was switched off there${f}`],
    ['at its stop, re-issued', { offReason: 'target', offAtMs: OFF_312, onReissues: 1 }, (f) => `force-charge reached ~56.7% at 3:12am and was switched off there, after one re-issue of the ON${f}`],
    ['no OFF', {}, (f) => `force-charge ran toward ~56.7%${f}`],
    ['no OFF, re-issued', { onReissues: 1 }, (f) => `force-charge ran toward ~56.7%, after one re-issue of the ON${f}`],
    ['the window end', { offReason: 'windowEnd', offAtMs: CLOSE_5 }, (f) => `force-charge ran toward ~56.7% until the window close${f}`],
    ['the window end, re-issued', { offReason: 'windowEnd', offAtMs: CLOSE_5, onReissues: 2 }, (f) => `force-charge ran toward ~56.7% until the window close, after 2 re-issues of the ON${f}`],
    ['an early OFF', { offReason: 'maxRun', offAtMs: OFF_230 }, (f) => `force-charge ran toward ~56.7%${f} and was switched off at 2:30am (the run backstop)`],
    ['an early OFF, re-issued', { offReason: 'maxRun', offAtMs: OFF_230, onReissues: 1 }, (f) => `force-charge ran toward ~56.7%${f} and was switched off at 2:30am (the run backstop), after one re-issue of the ON`],
    ['an early OFF, no time', { offReason: 'gridLoss' }, (f) => `force-charge ran toward ~56.7%${f} and was switched off before the window close (the grid was lost)`],
    ['an early OFF, no time, re-issued', { offReason: 'disabled', onReissues: 1 }, (f) => `force-charge ran toward ~56.7%${f} and was switched off before the window close (the force-charge was disabled by the options), after one re-issue of the ON`],
  ];
  const closes: Array<[Partial<NightChargeCostClose>, string]> = [
    [{}, AT_49],
    [{ poolPct: 61, readLate: true }, '; the pool reads 61% now, past the window close; the evening notice named ~56.7%'],
    [{ poolPct: null }, '; the pool was not read at the close (no fresh panel reading); the evening notice named ~56.7%'],
    [{ poolPct: null, announcedLevelPct: null }, '; the pool was not read at the close (no fresh panel reading)'],
  ];
  let n = 0;
  for (const [name, off, words] of forms) for (const [cl, closeWords] of closes) {
    // With the figure: once, on the phrase.
    const withFig = msg(night(ran, close({ ...off, ...cl })));
    assert.equal(withFig.title, T_PLAIN, name);
    assert.equal(withFig.body, body(COMPLETED, `reserve raised to 50%, and ${words(' (~6.2 kWh expected)')}${closeWords}`), name);
    assert.equal(withFig.body.split('kWh expected').length - 1, 1, name);
    assert.ok(withFig.body.indexOf('(~6.2 kWh expected)') < withFig.body.indexOf('; the pool '), name);
    // With none to state (it counts no force-charge leg, or there is none): the same words less the figure.
    for (const [fc, over] of [[{ kind: 'ran', stopPct: 56.7, expectedLeg: false }, {}], [ran, { expectedKwh: null }]] as Array<[Outcome, Partial<Input>]>) {
      assert.equal(msg(night(fc, close({ ...off, ...cl }), over)).body, body(COMPLETED, `reserve raised to 50%, and ${words('')}${closeWords}`), name);
    }
    n++;
  }
  assert.equal(n, 11 * 4);
  // It rides no force-charge that failed, was never confirmed or never started, whatever ended it.
  for (const fc of [failedAll, failedSome, unconfirmed, neverStarted]) for (const [, off] of forms) {
    assert.doesNotMatch(msg(night(fc, close(off))).body, /kWh expected/, fc.kind);
  }
});

test('★★★ C9 no two brackets in a row: the figure, an OFF\'s cause, the failed slots, the grid note, the left-out slots and a close with no reading', () => {
  // Each beside the bracket it stood against, word for word.
  const unread = '; the pool was not read at the close (no fresh panel reading)';
  const cases: Array<[string, Input, string, string, string]> = [
    ['the figure and a close with no reading', night(ran, close({ poolPct: null, announcedLevelPct: null })), T_PLAIN, COMPLETED,
      `reserve raised to 50%, and force-charge ran toward ~56.7% (~6.2 kWh expected)${unread}`],
    ['an early OFF and a re-issue', night(ran, close({ offReason: 'maxRun', offAtMs: OFF_230, onReissues: 1, poolPct: null, announcedLevelPct: null })), T_PLAIN, COMPLETED,
      `reserve raised to 50%, and force-charge ran toward ~56.7% (~6.2 kWh expected) and was switched off at 2:30am (the run backstop), after one re-issue of the ON${unread}`],
    ['an early OFF and a close with no reading', night(ran, close({ offReason: 'gridLoss', offAtMs: OFF_230, poolPct: null, announcedLevelPct: null })), T_PLAIN, COMPLETED,
      `reserve raised to 50%, and force-charge ran toward ~56.7% (~6.2 kWh expected) and was switched off at 2:30am (the grid was lost)${unread}`],
    ['the failed slots and an early OFF, no count', night(failedSome, unusable({ onReissues: Number.NaN, offReason: 'maxRun', offAtMs: OFF_230, poolPct: null, announcedLevelPct: null })), T_SLOTS_2_3, NOT_EVERY_SLOT,
      `${FAILED_SOME_WORDS}; it was switched off at 2:30am (the run backstop)${unread}`],
    ['the failed slots and a close with no reading, no count', night(failedSome, unusable({ onReissues: Number.NaN, poolPct: null, announcedLevelPct: null })), T_SLOTS_2_3, NOT_EVERY_SLOT,
      `${FAILED_SOME_WORDS}${unread}`],
    ['the grid note and a close with no reading', night(neverStarted, close({ poolPct: null }), { gridLost: true }), T_NOT_RUN, NO_FORCE_CHARGE,
      `reserve raised to 50%; force-charge toward ~56.7% never started (the grid read as lost)${unread}; the evening notice named ~56.7%`],
    ['an early OFF, the left-out slots and a close with no reading', night(unconfirmed, close({ offReason: 'foreign', offAtMs: OFF_230, leftOutSlots: [1], poolPct: null, announcedLevelPct: null })), T_NOT_CONFIRMED, UNCONFIRMED,
      `${UNCONFIRMED_WORDS}; it was switched off at 2:30am (the reserve was set outside the add-on)${leftOut('1')}${unread}`],
    ['the figure and the left-out slots', night(ran, close({ leftOutSlots: [1], poolPct: null, announcedLevelPct: null })), T_PLAIN, COMPLETED,
      `reserve raised to 50%, and force-charge ran toward ~56.7% (~6.2 kWh expected)${leftOut('1')}${unread}`],
    ['a held reserve and an early OFF', night(ran, close({ offReason: 'maxRun', offAtMs: OFF_230, onReissues: 1 }), { expectedKwh: 0 }), T_PLAIN, COMPLETED,
      `the reserve was held at 50% overnight as a floor (no charge was expected), and force-charge ran toward ~56.7% and was switched off at 2:30am (the run backstop), after one re-issue of the ON${AT_49}`],
  ];
  for (const [name, input, title, lead, account] of cases) {
    const m = msg(input);
    assert.deepEqual(m, whole(title, lead, account), name);
    assert.doesNotMatch(m.body, TWO_BRACKETS, name);
    // The restore sent: its own bracket follows words, never another bracket.
    const acked = msg({ ...input, restore: 'acknowledged' });
    assert.equal(acked.body, `Supervised night charge for ${DAY} ${lead}: ${account}; ${ACKED}${TAIL}`, name);
    assert.doesNotMatch(acked.body, TWO_BRACKETS, name);
  }
  // The pattern reads the shape the account had before: a figure straight after a close with no reading, a count after an OFF's cause.
  assert.match('the pool was not read at the close (no fresh panel reading) (~6.2 kWh expected)', TWO_BRACKETS);
  assert.match('until 2:30am (switched off: the run backstop) (after one re-issue of the ON)', TWO_BRACKETS);
  assert.match('did not take effect on slot(s)  (the buy above the reserve', TWO_BRACKETS);
  assert.doesNotMatch('did not take effect on slot(s) 2, 3 (the buy above the reserve did not happen on those slot(s)), with no re-issue', TWO_BRACKETS);
});

test('★★★ C9 a slot the ON was not sent to, on a night that ran: named after the charge\'s phrase and ahead of the close', () => {
  const m = msg(night(ran, close({ offReason: 'target', offAtMs: OFF_312, poolPct: 57, leftOutSlots: [1] })));
  assert.deepEqual(m, {
    severity: 'info',
    dedupId: 'night_charge_actuation',
    title: 'Night-charge: reserve restored to 16%',
    body: 'Supervised night charge for 2026-11-16 completed: reserve raised to 50%, and force-charge reached ~56.7% at 3:12am and was switched off there '
      + '(~6.2 kWh expected); slot(s) 1 not switched on (named out of the backup pool by the pool alarm); '
      + 'the pool read 57% at the close, against the ~56.7% the evening notice named; the reserve is restored to 16%. '
      + "Delivery vs plan scores in the ledger at tomorrow evening's update.",
  });
  // Two slots, on each of the other forms.
  assert.deepEqual(msg(night(ran, close({ leftOutSlots: [1, 3] }))), whole(T_PLAIN, COMPLETED,
    `reserve raised to 50%, and force-charge ran toward ~56.7% (~6.2 kWh expected); slot(s) 1, 3 not switched on (named out of the backup pool by the pool alarm)${AT_49}`));
  assert.deepEqual(msg(night(ran, close({ offReason: 'windowEnd', offAtMs: CLOSE_5, onReissues: 1, leftOutSlots: [2] }))), whole(T_PLAIN, COMPLETED,
    `reserve raised to 50%, and force-charge ran toward ~56.7% until the window close, after one re-issue of the ON (~6.2 kWh expected)${leftOut('2')}${AT_49}`));
  assert.deepEqual(msg(night(ran, close({ offReason: 'maxRun', offAtMs: OFF_230, onReissues: 1, leftOutSlots: [1, 3], poolPct: null }))), whole(T_PLAIN, COMPLETED,
    'reserve raised to 50%, and force-charge ran toward ~56.7% (~6.2 kWh expected) and was switched off at 2:30am (the run backstop), after one re-issue of the ON'
    + '; slot(s) 1, 3 not switched on (named out of the backup pool by the pool alarm); the pool was not read at the close (no fresh panel reading); the evening notice named ~56.7%'));
  assert.deepEqual(msg(night(ran, close({ leftOutSlots: [2, 3], poolPct: 61, readLate: true }))), whole(T_PLAIN, COMPLETED,
    `reserve raised to 50%, and force-charge ran toward ~56.7% (~6.2 kWh expected)${leftOut('2, 3')}; the pool reads 61% now, past the window close; the evening notice named ~56.7%`));
  // With no figure to state, and on a reserve that stood with its restore not due.
  assert.equal(msg(night(ran, close({ leftOutSlots: [1] }), { expectedKwh: null })).body, body(COMPLETED,
    `reserve raised to 50%, and force-charge ran toward ~56.7%${leftOut('1')}${AT_49}`));
  assert.equal(msg(night(ran, close({ leftOutSlots: [1] }), { standing: true })).body, body(COMPLETED,
    `the reserve stood at 50%, and force-charge ran toward ~56.7% (~6.2 kWh expected)${leftOut('1')}${AT_49}`, STOOD));
  // None on the record (omitted, null, empty): nothing said.
  for (const none of [undefined, null, []]) {
    const plain = msg(night(ran, close({ leftOutSlots: none })));
    assert.deepEqual(plain, msg(night(ran, close())), String(none));
    assert.doesNotMatch(plain.body, /not switched on|pool alarm|slot/);
  }
});

test('★★★ C9 a slot the ON was not sent to, on a failed night: after the failure, its re-issue and what ended it; the lead and title unmoved', () => {
  const m = msg(night(failedAll, close({ leftOutSlots: [1] })));
  assert.deepEqual(m, {
    severity: 'info',
    dedupId: 'night_charge_actuation',
    title: 'Night-charge: force-charge did not take effect — reserve restored to 16%',
    body: 'Supervised night charge for 2026-11-16 closed without its force-charge: reserve raised to 50%; force-charge toward ~56.7% was switched ON '
      + 'but did not take effect, with no re-issue of the ON; slot(s) 1 not switched on (named out of the backup pool by the pool alarm); '
      + 'the pool read 49% at the close, against the ~56.7% the evening notice named; the reserve is restored to 16%. '
      + "Delivery vs plan scores in the ledger at tomorrow evening's update.",
  });
  // After the stop, on a failure that named its slots: the title names the failed slots only.
  assert.deepEqual(msg(night({ kind: 'failed', stopPct: 56.7, expectedLeg: true, partialSlots: [2] }, close({ offReason: 'target', offAtMs: OFF_312, poolPct: 57, leftOutSlots: [1] }))), whole(
    'Night-charge: force-charge not applied on slot(s) 2 — reserve restored to 16%', NOT_EVERY_SLOT,
    'reserve raised to 50%; force-charge toward ~56.7% was switched ON but did not take effect on slot(s) 2 (the buy above the reserve did not happen on those slot(s)), '
    + `with no re-issue of the ON; the pool read ~56.7% at 3:12am and the force-charge was switched off there${leftOut('1')}${AT_57}`));
  // After an early OFF, two slots.
  assert.deepEqual(msg(night(failedAll, close({ offReason: 'maxRun', offAtMs: OFF_230, onReissues: 1, leftOutSlots: [1, 2] }))), whole(T_NO_EFFECT, NO_FORCE_CHARGE,
    `${FAILED_ALL_WORDS}, after one re-issue of the ON; it was switched off at 2:30am (the run backstop)${leftOut('1, 2')}${AT_49}`));
  // On every slot at its stop.
  assert.deepEqual(msg(night(failedAll, close({ offReason: 'target', offAtMs: null, leftOutSlots: [3] }))), whole(T_ON_NOT_CONFIRMED, ON_NOT_CONFIRMED,
    `${FAILED_AT_STOP_WORDS}, with no re-issue of the ON; the pool read ~56.7% and the force-charge was switched off there${leftOut('3')}${AT_49}`));
  // With a count that is no count, and a close with no reading.
  assert.deepEqual(msg(night(failedSome, unusable({ onReissues: 'x', leftOutSlots: [1], poolPct: null }))), whole(T_SLOTS_2_3, NOT_EVERY_SLOT,
    `${FAILED_SOME_WORDS}${leftOut('1')}; the pool was not read at the close (no fresh panel reading); the evening notice named ~56.7%`));
  // The lead and the title are those of the same night with no slot left out.
  for (const fc of [failedAll, failedSome, failedEmpty]) for (const from of [close(), close({ offReason: 'target', offAtMs: OFF_312 }), close({ offReason: 'maxRun', offAtMs: OFF_230 })]) {
    const withSlot = msg(night(fc, { ...from, leftOutSlots: [1] }));
    const without = msg(night(fc, from));
    assert.equal(withSlot.title, without.title, fc.kind);
    assert.equal(withSlot.body.replace(leftOut('1'), ''), without.body, fc.kind);
  }
});

test('★★★ C9 a slot the ON was not sent to, on an unconfirmed night: at its stop under "completed", short of it under the flag', () => {
  const m = msg(night(unconfirmed, close({ offReason: 'target', offAtMs: OFF_1220, poolPct: 57, leftOutSlots: [1] })));
  assert.deepEqual(m, {
    severity: 'info',
    dedupId: 'night_charge_actuation',
    title: 'Night-charge: reserve restored to 16%',
    body: 'Supervised night charge for 2026-11-16 completed: reserve raised to 50%; force-charge reached ~56.7% at 12:20am and was switched off there, '
      + 'with no readback showing every slot ON; slot(s) 1 not switched on (named out of the backup pool by the pool alarm); '
      + 'the pool read 57% at the close, against the ~56.7% the evening notice named; the reserve is restored to 16%. '
      + "Delivery vs plan scores in the ledger at tomorrow evening's update.",
  });
  assert.deepEqual(msg(night(unconfirmed, close({ offReason: 'target', offAtMs: null, poolPct: 57, onReissues: 1, leftOutSlots: [1, 2] }))), whole(T_PLAIN, COMPLETED,
    `reserve raised to 50%; force-charge reached ~56.7% and was switched off there, with no readback showing every slot ON, after one re-issue of the ON${leftOut('1, 2')}${AT_57}`));
  // Short of its stop: the window end, no OFF, an early OFF.
  assert.deepEqual(msg(night(unconfirmed, close({ offReason: 'windowEnd', offAtMs: CLOSE_5, leftOutSlots: [3] }))), whole(T_NOT_CONFIRMED, UNCONFIRMED,
    `${UNCONFIRMED_WORDS}${leftOut('3')}${AT_49}`));
  assert.deepEqual(msg(night(unconfirmed, close({ onReissues: 1, leftOutSlots: [2, 3] }))), whole(T_NOT_CONFIRMED, UNCONFIRMED,
    `${UNCONFIRMED_WORDS}, after one re-issue of the ON${leftOut('2, 3')}${AT_49}`));
  assert.deepEqual(msg(night(unconfirmed, close({ offReason: 'maxRun', offAtMs: OFF_230, onReissues: 1, leftOutSlots: [1], poolPct: null }))), whole(T_NOT_CONFIRMED, UNCONFIRMED,
    `${UNCONFIRMED_WORDS}, after one re-issue of the ON; it was switched off at 2:30am (the run backstop)${leftOut('1')}`
    + '; the pool was not read at the close (no fresh panel reading); the evening notice named ~56.7%'));
});

test('★★★ C9 the left-out list names positive whole numbers only: 0, -1, 1.5, NaN, a string and a list that is no list name nothing', () => {
  const nothing: unknown[] = [
    null, undefined, [], [0], [-1], [1.5], [Number.NaN], ['1'], [Number.POSITIVE_INFINITY], [null], [undefined], [[1]], [true], [{}],
    [0, -1, 1.5, Number.NaN, '2'], '1', '1, 2', 1, true, {}, { 0: 1, length: 1 },
  ];
  const bases = [close(), close({ offReason: 'target', offAtMs: OFF_312, poolPct: 57 }), close({ offReason: 'maxRun', offAtMs: OFF_230, onReissues: 1, poolPct: null })];
  let n = 0;
  for (const bad of nothing) for (const fc of SWITCHED_ON) for (const from of bases) {
    const what = `${fc.kind} ${JSON.stringify(bad)}`;
    const m = built(night(fc, unusable({ leftOutSlots: bad }, from)), what);
    assert.deepEqual(m, msg(night(fc, from)), what);
    assert.doesNotMatch(`${m.title} ${m.body}`, /not switched on|pool alarm/, what);
    assert.doesNotMatch(`${m.title} ${m.body}`, TOKENS, what);
    n++;
  }
  assert.equal(n, 21 * 4 * 3);
  // A list that mixes them names the slots that are slots, in the order given.
  for (const fc of SWITCHED_ON) for (const from of bases) {
    const mixed = built(night(fc, unusable({ leftOutSlots: [1, 0, -1, 1.5, Number.NaN, '2', null, 3] }, from)), fc.kind);
    assert.deepEqual(mixed, msg(night(fc, { ...from, leftOutSlots: [1, 3] })), fc.kind);
    assert.equal(mixed.body.split(leftOut('1, 3')).length - 1, 1, fc.kind);
    assert.doesNotMatch(`${mixed.title} ${mixed.body}`, TOKENS, fc.kind);
  }
});

test('★★★ C9 the left-out list is never read where the account is not: never started, another level announced, a line, reserve only, an early end, no stop', () => {
  const left = [close({ leftOutSlots: [1] }), close({ leftOutSlots: [1, 2], poolPct: 57 }), close({ leftOutSlots: [1, 2, 3], offReason: 'target', offAtMs: OFF_312 })];
  const silent = (m: ReturnType<typeof msg>, what: string): void => assert.doesNotMatch(`${m.title} ${m.body}`, /not switched on|pool alarm|backup pool/, what);
  for (const cost of left) {
    const { leftOutSlots: _dropped, ...without } = cost;
    // A force-charge that never started was sent no ON: flagged or not, its account names no slot.
    for (const over of [{}, { gridLost: true }, { standing: true }, { restore: 'acknowledged' as const }]) {
      const m = msg(night(neverStarted, cost, over));
      assert.deepEqual(m, msg(night(neverStarted, without, over)), JSON.stringify(cost));
      silent(m, 'never started');
    }
    // A never-started night whose notice named another level: the words of v1.208.0.
    for (const announcedLevelPct of [50, 80, null]) {
      const m = msg(night(neverStarted, { ...cost, announcedLevelPct }));
      assert.deepEqual(m, msg(night(neverStarted)), String(announcedLevelPct));
      silent(m, 'another level');
    }
    for (const fc of EVERY_KIND) {
      // A line on the input, or on the outcome.
      const lineIn = night(fc, undefined, { linePct: 69.4, closePoolPct: 62 });
      assert.deepEqual(msg({ ...lineIn, cost }), msg(lineIn), `${fc.kind}: a line on the input`);
      silent(msg({ ...lineIn, cost }), `${fc.kind}: a line on the input`);
      const lineOut = night({ ...fc, line: { askPct: 56, linePct: 55.55 } } as Riding, undefined, { closePoolPct: 52 });
      assert.deepEqual(msg({ ...lineOut, cost }), msg(lineOut), `${fc.kind}: a line on the outcome`);
      silent(msg({ ...lineOut, cost }), `${fc.kind}: a line on the outcome`);
      // An early end.
      for (const ended of ['cancelled', 'gridLoss'] as const) {
        const early = night(fc, undefined, { ended });
        assert.deepEqual(msg({ ...early, cost }), msg(early), `${fc.kind} ${ended}`);
        silent(msg({ ...early, cost }), `${fc.kind} ${ended}`);
      }
      // No finite stop.
      for (const stopPct of [null, Number.NaN]) {
        const noStop = night({ ...fc, stopPct } as Riding);
        assert.deepEqual(msg({ ...noStop, cost }), msg(noStop), `${fc.kind} ${stopPct}`);
        silent(msg({ ...noStop, cost }), `${fc.kind} ${stopPct}`);
      }
    }
    // Reserve only.
    for (const fc of [null, { kind: 'none', expectedLeg: false }, { kind: 'none', expectedLeg: true }] as Array<Outcome | null>) {
      const base = night(fc);
      assert.deepEqual(msg({ ...base, cost }), msg(base), JSON.stringify(fc));
      silent(msg({ ...base, cost }), 'reserve only');
    }
  }
  // Not vacuous: each of those accounts names its slots on a force-charge that was switched on.
  for (const cost of left) for (const fc of SWITCHED_ON) {
    assert.match(msg(night(fc, cost)).body, /; slot\(s\) 1(, 2(, 3)?)? not switched on \(named out of the backup pool by the pool alarm\); the pool /, fc.kind);
  }
});
