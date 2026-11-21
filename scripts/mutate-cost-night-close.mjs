#!/usr/bin/env node
/**
 * mutate-cost-night-close.mjs — committed harness for v1.209.0: a cost night's morning summary states its close.
 *
 * Until this release the morning summary of a night with no outage line stated no close. On 2026-11-16 a top-up that two of
 * three slots never took closed at 49% against an announced 56.7% under the title "reserve restored to 16%" and the lead
 * "completed". The summary now takes the record's account of such a night (notify.ts buildNightChargeMorningSummary `cost`,
 * costNightAccount; index.ts sendRestoreSummary). Each mutant below removes or moves one rule of that account.
 *
 * (G) THE GUARDS of costNightAccount: no close account passed, no finite stop on the outcome, a force-charge that never
 *     started on a night whose evening notice named a level other than the stop.
 * (A) THE ANNOUNCED LEVEL: read finite, to one decimal; "a start was announced" is round1(announced) === round1(stop).
 * (C) THE CLOSE CLAUSE: the reading to one decimal; not read, read late, read at the close; the announced level beside each
 *     form, and dropped where the record has none.
 * (O) WHAT ENDED THE FORCE-CHARGE: "reached" only on a target OFF with its time; the window-end OFF; no OFF reason; any other
 *     OFF with its clock and its cause.
 * (R) THE ON RE-ISSUES: counted only as a positive whole number, "one re-issue" and "N re-issues", said on a verified and on
 *     an unconfirmed night only where made, and either way on a night the ON did not take effect.
 * (K) EACH SHAPE'S OWN WORDS: the close clause on every shape, the expected figure beside a force-charge that ran, the grid
 *     read as lost, the stop named, "with no readback showing every slot ON".
 * (F) THE FLAG: null on a force-charge that ran and on an unconfirmed one whose stop was read; the lead and the title of a
 *     start that never came, of an ON that failed on every slot or on some, and of an ON never confirmed short of its stop.
 * (B) THE BUILDER'S BLOCK: the account read only where neither the input nor the outcome carries a line; the six words
 *     handed to it; the night and the flag each taken from it; the flagged return (its title with the restore half in its
 *     three forms, its lead, the ledger sentence, the summary's own severity and id); an unflagged account under the
 *     unflagged return.
 * (X) THE WIRING (index.ts sendRestoreSummary): `cost` only where the record carries no line, and each of its six fields from
 *     its own source. index.ts cannot be imported by a test, so these are held by the source check in
 *     test/costNightClose.test.ts (C7).
 *
 *   node scripts/mutate-cost-night-close.mjs [--only <id prefix>]
 *
 * ★ Every id starts CNC- (no other harness uses it). Anchor-asserted (each anchor matches exactly once); every mutant must
 *   TYPECHECK (one that does not is reported INVALID and fails the run); the subset alone decides (no full-suite step), and
 *   the failing tests of each mutant are named. Run with MUTATE_CONCURRENCY=4, on a GREEN tree.
 *
 * Not written, because no typed input tells them apart: the `!= null` half beside each Number.isFinite test (the stop, the
 * announced level, the reading, the OFF time: Number.isFinite(null) is false); `announced != null` in the start test (null ===
 * stop is false); `> 0` in the re-issue count and `=== 1` against `<= 1` in its words (every use of the count is behind
 * `reissues > 0`); `=== true` against a truthy test of readLate (a boolean); `${w.note}` on the four shapes other than "ran"
 * (the builder passes '' there). B-iii (the `line == null` half) is told apart only by an outcome line with no level, which
 * no record of the add-on's has: test/costNightClose.test.ts holds it with such a line, beside the source check.
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = resolve(REPO, 'server');
const NOTIFY = resolve(SERVER, 'src/notify.ts');
const INDEX = resolve(SERVER, 'src/index.ts');

const SUBSET = [
  'test/costNightClose.test.ts',
  'test/lineForceChargeAtRisk.test.ts',
  'test/overnightTextGolden.test.ts',
  'test/nightChargeExpectedBuy.test.ts',
  'test/lineForceCharge.test.ts',
];

const NL = "\n";

/* costNightAccount (notify.ts), line by line. */
const GUARD = "  if (cost == null || fc.stopPct == null || !Number.isFinite(fc.stopPct)) return null;";
const STOP = "  const stop = round1(fc.stopPct);";
const ANNOUNCED = "  const announced = cost.announcedLevelPct != null && Number.isFinite(cost.announcedLevelPct) ? round1(cost.announcedLevelPct) : null;";
const START = "  const startAnnounced = announced != null && announced === stop;";
const NEVER_GUARD = "  if (fc.kind === 'neverStarted' && !startAnnounced) return null;";
const READ = "  const read = cost.poolPct != null && Number.isFinite(cost.poolPct) ? round1(cost.poolPct) : null;";
const NAMED_AFTER = "  const namedAfter = announced != null ? `; the evening notice named ~${announced}%` : '';";
const UNREAD = "  const close = read == null ? `; the pool was not read at the close (no fresh panel reading)${namedAfter}`";
const LATE = "    : cost.readLate === true ? `; the pool reads ${read}% now, past the window close${namedAfter}`";
const AT_CLOSE = "      : `; the pool read ${read}% at the close${announced != null ? `, against the ~${announced}% the evening notice named` : ''}`;";
const OFF_AT = "  const offAt = cost.offAtMs != null && Number.isFinite(cost.offAtMs) ? cost.offAtMs : null;";
const REACHED_IF = "  const reached = cost.offReason === 'target' && offAt != null";
const REACHED_WORDS = "    ? `reached ~${stop}% at ${phxShortClock(offAt)} and was switched off there` : null;";
const REISSUES = "  const reissues = Number.isInteger(cost.onReissues) && cost.onReissues > 0 ? cost.onReissues : 0;";
const REISSUE_WORDS = "  const reissueWords = reissues === 1 ? 'one re-issue of the ON' : `${reissues} re-issues of the ON`;";
const KIND_RAN = "  if (fc.kind === 'ran') {";
const RAN_REACHED = "    const ran = reached";
const RAN_NONE = "      ?? (cost.offReason == null ? `ran${w.toward}`";
const RAN_WINDOW = "        : cost.offReason === 'windowEnd' ? `ran${w.toward} until the window close`";
const RAN_OTHER = "          : `ran${w.toward} until ${offAt != null ? phxShortClock(offAt) : 'before the window close'} (switched off: ${forceChargeOffWords(cost.offReason)})`);";
const RAN_NIGHT = "      night: `${w.reserve}, and force-charge ${ran}${reissues > 0 ? ` (after ${reissueWords})` : ''}${close}${w.note}; ${w.restored}`,";
const FLAG_NULL = "      flagged: null,";
const KIND_NEVER = "  if (fc.kind === 'neverStarted') {";
const NEVER_NIGHT = "      night: `${w.reserve}${w.note}; force-charge${w.toward} never started${w.gridLost ? ' (the grid read as lost)' : ''}${close}; ${w.restored}`,";
const NEVER_FLAG = "      flagged: { lead: 'closed without its force-charge', title: 'force-charge did not run' },";
const KIND_FAILED = "  if (fc.kind === 'failed') {";
const FAILED_NIGHT = "      night: `${w.reserve}${w.note}; force-charge${w.toward} ${w.failedOn}, ${reissues > 0 ? `after ${reissueWords}` : 'with no re-issue of the ON'}${close}; ${w.restored}`,";
const FAILED_FLAG_IF = "      flagged: fc.partialSlots != null";
const FAILED_FLAG_SOME = "        ? { lead: 'closed with its force-charge not applied on every slot', title: `force-charge not applied on slot(s) ${fc.partialSlots.join(', ')}` }";
const FAILED_FLAG_ALL = "        : { lead: 'closed without its force-charge', title: 'force-charge did not take effect' },";
const REACHED_BRANCH = "  if (reached != null) {";
const UNCONF_REACHED_NIGHT = "      night: `${w.reserve}${w.note}; force-charge ${reached}, with no readback showing every slot ON${close}; ${w.restored}`,";
const UNCONF_NIGHT = "    night: `${w.reserve}${w.note}; force-charge${w.toward} was switched ON but the panel never confirmed it${reissues > 0 ? `, after ${reissueWords}` : ''}${close}; ${w.restored}`,";
const UNCONF_FLAG = "    flagged: { lead: 'closed with its force-charge unconfirmed', title: 'force-charge not confirmed' },";

/* buildNightChargeMorningSummary (notify.ts): the lines v1.209.0 added. */
const FLAGGED_INIT = "  let flagged: { lead: string; title: string } | null = null;";
const COST_IF = "    const costAccount = linePct == null && line == null";
const COST_CALL = "      ? costNightAccount(o.cost, fc, { reserve, toward, note, restored, failedOn, gridLost: o.gridLost === true }) : null;";
const ACCOUNT_IF = "    if (costAccount != null) {";
const NIGHT_SET = "      night = costAccount.night;";
const FLAG_SET = "      flagged = costAccount.flagged;";
const FLAG_IF = "  if (flagged != null) {";
const FLAG_RETURN_HEAD = "    return {\n      ...base,";
const FLAG_TITLE = "      title: `Night-charge: ${flagged.title} — ${stood ? `reserve stood at ${raised}` : titleRestore}`,";
const FLAG_BODY = "        `Supervised night charge for ${day} ${flagged.lead}: ${night}`";
const FLAG_LEDGER = "        + \"Delivery vs plan scores in the ledger at tomorrow evening's update.\",";

/* sendRestoreSummary (index.ts). */
const COST_GUARD = "      cost: lineNight == null ? {";
const COST_L1 = "        announcedLevelPct: state.announcedLevelPct, poolPct: freshPoolSocPct(nowMs), readLate: lineCloseReadingLate(state, nowMs),";
const COST_L2 = "        offReason: state.forceChargeOffReason, offAtMs: state.forceChargeOffAtMs, onReissues: state.forceChargeOnRetries,";

const MUTANTS = [
  /* ── G: the guards ── */
  {
    id: 'CNC-G-i. ★★★ an absent close account is read as an empty one',
    file: NOTIFY,
    find: GUARD,
    to: "  cost = cost ?? { announcedLevelPct: null, poolPct: null, readLate: false, offReason: null, offAtMs: null, onReissues: 0 }; if (fc.stopPct == null || !Number.isFinite(fc.stopPct)) return null; /* MUTANT */",
    why: 'With no `cost` passed, a night whose force-charge ran says "the pool was not read at the close (no fresh panel reading)", and a failed one is flagged: the words of v1.208.0 are gone on every cost night.',
  },
  {
    id: 'CNC-G-ii. ★★★ an outcome with no stop takes the account',
    file: NOTIFY,
    find: GUARD + NL + STOP,
    to: "  if (cost == null || (fc.stopPct != null && !Number.isFinite(fc.stopPct))) return null; /* MUTANT */\n  const stop = round1(fc.stopPct ?? 0);",
    why: 'A record with no stop says "force-charge ran; the pool read 49% at the close, against the ~56.7% the evening notice named", and "reached ~0%" on a target OFF.',
  },
  {
    id: 'CNC-G-iii. ★★★ an outcome with a non-finite stop takes the account',
    file: NOTIFY,
    find: GUARD,
    to: "  if (cost == null || fc.stopPct == null) return null; /* MUTANT */",
    why: 'A NaN stop says "force-charge ran; the pool read 49% at the close…" with no level beside "ran", and "reached ~NaN%" on a target OFF.',
  },
  {
    id: 'CNC-G-iv. ★★★ a never-started night is flagged whatever the evening notice named',
    file: NOTIFY,
    find: NEVER_GUARD,
    to: "  void startAnnounced; /* MUTANT */",
    why: 'A night whose notice expected no start (it named the 50% reserve) goes under "closed without its force-charge" and the title "force-charge did not run".',
  },
  {
    id: 'CNC-G-v. ★★★ the start-announced test is applied to every outcome',
    file: NOTIFY,
    find: NEVER_GUARD,
    to: "  if (!startAnnounced) return null; /* MUTANT */",
    why: 'An ON that was written and did not take effect, on a night whose notice named another level, goes under "completed" with no close stated.',
  },
  {
    id: 'CNC-G-vi. ★★★ the start-announced test is inverted',
    file: NOTIFY,
    find: NEVER_GUARD,
    to: "  if (fc.kind === 'neverStarted' && startAnnounced) return null; /* MUTANT */",
    why: 'The announced start that never came goes under "completed"; the night that expected none goes under "force-charge did not run".',
  },
  {
    id: 'CNC-G-vii. ★★★ a never-started night never takes the account',
    file: NOTIFY,
    find: NEVER_GUARD,
    to: "  if (fc.kind === 'neverStarted' && cost != null) return null; /* MUTANT */",
    why: 'A force-charge the evening notice announced, and that never started, goes under "completed" and "reserve restored to 16%".',
  },

  /* ── A: the announced level, and "a start was announced" ── */
  {
    id: 'CNC-A-i. ★★★ any announced level counts as a start announced',
    file: NOTIFY,
    find: START,
    to: "  const startAnnounced = announced != null; /* MUTANT */",
    why: 'A never-started night whose notice named the written reserve (50%) is flagged "force-charge did not run".',
  },
  {
    id: 'CNC-A-ii. ★★★ the equality is inverted',
    file: NOTIFY,
    find: START,
    to: "  const startAnnounced = announced != null && announced !== stop; /* MUTANT */",
    why: 'Flagged where the notice named another level; "completed" where it named the stop.',
  },
  {
    id: 'CNC-A-iii. ★★★ the equality reads the unrounded stop',
    file: NOTIFY,
    find: START,
    to: "  const startAnnounced = announced != null && announced === fc.stopPct; /* MUTANT */",
    why: 'A 56.74 stop the notice named as ~56.7% is no start announced: the start that never came goes under "completed".',
  },
  {
    id: 'CNC-A-iv. ★★★ the equality is taken to the whole percent',
    file: NOTIFY,
    find: START,
    to: "  const startAnnounced = announced != null && Math.round(announced) === Math.round(stop); /* MUTANT */",
    why: 'A notice that named ~56.8% or ~56.6% counts as naming the ~56.7% stop: "force-charge did not run" on a night that announced another level.',
  },
  {
    id: 'CNC-A-v. ★★★ a level at or above the stop counts as a start announced',
    file: NOTIFY,
    find: START,
    to: "  const startAnnounced = announced != null && announced >= stop; /* MUTANT */",
    why: 'A notice that named 80% beside a ~56.7% stop flags the night "force-charge did not run".',
  },
  {
    id: 'CNC-A-vi. ★★★ a level at or under the stop counts as a start announced',
    file: NOTIFY,
    find: START,
    to: "  const startAnnounced = announced != null && announced <= stop; /* MUTANT */",
    why: 'A notice that named the 50% reserve beside a ~56.7% stop flags the night "force-charge did not run".',
  },
  {
    id: 'CNC-A-vii. ★★★ the announced level is not rounded',
    file: NOTIFY,
    find: ANNOUNCED,
    to: "  const announced = cost.announcedLevelPct != null && Number.isFinite(cost.announcedLevelPct) ? cost.announcedLevelPct : null; /* MUTANT */",
    why: '"against the ~56.74% the evening notice named", and an announced 56.66 beside a ~56.7% stop is no start announced.',
  },
  {
    id: 'CNC-A-viii. ★★★ a non-finite announced level is taken as a level',
    file: NOTIFY,
    find: ANNOUNCED,
    to: "  const announced = cost.announcedLevelPct != null ? round1(cost.announcedLevelPct) : null; /* MUTANT */",
    why: '"against the ~NaN% the evening notice named".',
  },
  {
    id: 'CNC-A-ix. ★★★ the stop is not rounded',
    file: NOTIFY,
    find: STOP,
    to: "  const stop = fc.stopPct; /* MUTANT */",
    why: '"reached ~56.74% at 3:12am" beside "toward ~56.7%", and a 56.74 stop named as ~56.7% is no start announced.',
  },

  /* ── C: the close clause ── */
  {
    id: 'CNC-C-i. ★★★ the reading is not rounded',
    file: NOTIFY,
    find: READ,
    to: "  const read = cost.poolPct != null && Number.isFinite(cost.poolPct) ? cost.poolPct : null; /* MUTANT */",
    why: '"the pool read 61.26% at the close".',
  },
  {
    id: 'CNC-C-ii. ★★★ the reading is rounded to the whole percent',
    file: NOTIFY,
    find: READ,
    to: "  const read = cost.poolPct != null && Number.isFinite(cost.poolPct) ? Math.round(cost.poolPct) : null; /* MUTANT */",
    why: 'A 61.26% reading is told as "61%" and a 48.94% one as "49%": one decimal of the panel\'s reading is dropped.',
  },
  {
    id: 'CNC-C-iii. ★★★ a non-finite reading is taken as a reading',
    file: NOTIFY,
    find: READ,
    to: "  const read = cost.poolPct != null ? round1(cost.poolPct) : null; /* MUTANT */",
    why: '"the pool read NaN% at the close".',
  },
  {
    id: 'CNC-C-iv. ★★★ an unread or late close never names the announced level',
    file: NOTIFY,
    find: NAMED_AFTER,
    to: "  const namedAfter = ''; /* MUTANT */",
    why: '"the pool was not read at the close (no fresh panel reading); the reserve is restored…": the level the night was announced at goes unsaid.',
  },
  {
    id: 'CNC-C-v. ★★★ an unread or late close names a level the record does not hold',
    file: NOTIFY,
    find: NAMED_AFTER,
    to: "  const namedAfter = `; the evening notice named ~${announced}%`; /* MUTANT */",
    why: '"; the evening notice named ~null%".',
  },
  {
    id: 'CNC-C-vi. ★★★ "late" is judged ahead of "no reading"',
    file: NOTIFY,
    find: UNREAD,
    to: "  const close = read == null && cost.readLate !== true ? `; the pool was not read at the close (no fresh panel reading)${namedAfter}` /* MUTANT */",
    why: '"the pool reads null% now, past the window close" where no reading was taken.',
  },
  {
    id: 'CNC-C-vii. ★★★ no reading at the close is told as a reading',
    file: NOTIFY,
    find: UNREAD,
    to: "  const close = read == null && cost.readLate === true ? `; the pool was not read at the close (no fresh panel reading)${namedAfter}` /* MUTANT */",
    why: '"the pool read null% at the close, against the ~56.7% the evening notice named".',
  },
  {
    id: 'CNC-C-viii. ★★★ the unread close drops the announced level',
    file: NOTIFY,
    find: UNREAD,
    to: "  const close = read == null ? `; the pool was not read at the close (no fresh panel reading)` /* MUTANT */",
    why: 'A close with no reading says nothing of the ~56.7% the evening notice named.',
  },
  {
    id: 'CNC-C-ix. ★★★ a late reading is told as the close\'s',
    file: NOTIFY,
    find: LATE,
    to: "    : cost.readLate === true ? `; the pool read ${read}% at the close${announced != null ? `, against the ~${announced}% the evening notice named` : ''}` /* MUTANT */",
    why: 'A summary sent hours after the close says "the pool read 61% at the close, against the ~56.7% the evening notice named".',
  },
  {
    id: 'CNC-C-x. ★★★ the late test is inverted',
    file: NOTIFY,
    find: LATE,
    to: "    : cost.readLate !== true ? `; the pool reads ${read}% now, past the window close${namedAfter}` /* MUTANT */",
    why: 'A reading taken at the close says "reads 49% now, past the window close".',
  },
  {
    id: 'CNC-C-xi. ★★★ the late close drops the announced level',
    file: NOTIFY,
    find: LATE,
    to: "    : cost.readLate === true ? `; the pool reads ${read}% now, past the window close` /* MUTANT */",
    why: '"the pool reads 61% now, past the window close" with nothing of the ~56.7% the evening notice named.',
  },
  {
    id: 'CNC-C-xii. ★★★ the close as read names a level the record does not hold',
    file: NOTIFY,
    find: AT_CLOSE,
    to: "      : `; the pool read ${read}% at the close, against the ~${announced}% the evening notice named`; /* MUTANT */",
    why: '"the pool read 55% at the close, against the ~null% the evening notice named".',
  },
  {
    id: 'CNC-C-xiii. ★★★ the close as read drops the announced level',
    file: NOTIFY,
    find: AT_CLOSE,
    to: "      : `; the pool read ${read}% at the close`; /* MUTANT */",
    why: 'The 2026-11-16 night says "the pool read 49% at the close" and the 56.7% it was announced at goes unsaid.',
  },

  /* ── O: what ended the force-charge ── */
  {
    id: 'CNC-O-i. ★★★ a non-finite OFF time is taken as a clock',
    file: NOTIFY,
    find: OFF_AT,
    to: "  const offAt = cost.offAtMs != null ? cost.offAtMs : null; /* MUTANT */",
    why: 'The clock formatter is handed NaN: the summary throws (and is never sent), or prints a clock that is none.',
  },
  {
    id: 'CNC-O-ii. ★★★ any OFF with its time is told as the stop reached',
    file: NOTIFY,
    find: REACHED_IF,
    to: "  const reached = cost.offReason != null && offAt != null /* MUTANT */",
    why: 'A run-backstop OFF at 2:30am says "reached ~56.7% at 2:30am and was switched off there".',
  },
  {
    id: 'CNC-O-iii. ★★★ the window-end OFF is told as the stop reached',
    file: NOTIFY,
    find: REACHED_IF,
    to: "  const reached = cost.offReason === 'windowEnd' && offAt != null /* MUTANT */",
    why: 'A force-charge that ran out the window says "reached ~56.7% at 5am", and a target OFF "ran toward ~56.7% until 3:12am (switched off: it reached its target)".',
  },
  {
    id: 'CNC-O-iv. ★★★ "reached" needs no OFF time',
    file: NOTIFY,
    find: REACHED_IF + NL + REACHED_WORDS,
    to: "  const reached = cost.offReason === 'target' /* MUTANT */\n    ? `reached ~${stop}%${offAt != null ? ` at ${phxShortClock(offAt)}` : ''} and was switched off there` : null;",
    why: 'A target OFF with no time on the record says "reached ~56.7% and was switched off there", a reading with no clock to it.',
  },
  {
    id: 'CNC-O-v. ★★★ "reached" names the unrounded stop',
    file: NOTIFY,
    find: REACHED_WORDS,
    to: "    ? `reached ~${fc.stopPct}% at ${phxShortClock(offAt)} and was switched off there` : null; /* MUTANT */",
    why: '"reached ~56.74% at 3:12am and was switched off there".',
  },
  {
    id: 'CNC-O-vi. ★★★ "reached" names the announced level, not the stop',
    file: NOTIFY,
    find: REACHED_WORDS,
    to: "    ? `reached ~${announced ?? stop}% at ${phxShortClock(offAt)} and was switched off there` : null; /* MUTANT */",
    why: 'On a night whose notice named the 50% reserve, a force-charge that read its ~56.7% stop says "reached ~50% at 3:12am".',
  },
  {
    id: 'CNC-O-vii. ★★★ a verified night never says "reached"',
    file: NOTIFY,
    find: RAN_REACHED,
    to: "    const ran = (offAt == null ? reached : null) /* MUTANT */",
    why: 'A force-charge switched off at its stop says "ran toward ~56.7% until 3:12am (switched off: it reached its target)".',
  },
  {
    id: 'CNC-O-viii. ★★★ no OFF on the record is told as the window close',
    file: NOTIFY,
    find: RAN_NONE,
    to: "      ?? (cost.offReason == null ? `ran${w.toward} until the window close` /* MUTANT */",
    why: 'A record with no OFF reason says "ran toward ~56.7% until the window close".',
  },
  {
    id: 'CNC-O-ix. ★★★ the window-end OFF is told as no OFF',
    file: NOTIFY,
    find: RAN_NONE,
    to: "      ?? (cost.offReason == null || cost.offReason === 'windowEnd' ? `ran${w.toward}` /* MUTANT */",
    why: 'A force-charge that ran to the window-end OFF says only "ran toward ~56.7%".',
  },
  {
    id: 'CNC-O-x. ★★★ the window-end OFF is told as an early one',
    file: NOTIFY,
    find: RAN_WINDOW,
    to: "        : cost.offReason === 'windowEnd' && false ? `ran${w.toward} until the window close` /* MUTANT */",
    why: '"ran toward ~56.7% until 5am (switched off: windowEnd)".',
  },
  {
    id: 'CNC-O-xi. ★★★ the window-end test is inverted',
    file: NOTIFY,
    find: RAN_WINDOW,
    to: "        : cost.offReason !== 'windowEnd' ? `ran${w.toward} until the window close` /* MUTANT */",
    why: 'A run-backstop OFF at 2:30am says "ran toward ~56.7% until the window close".',
  },
  {
    id: 'CNC-O-xii. ★★★ an early OFF never names its clock',
    file: NOTIFY,
    find: RAN_OTHER,
    to: "          : `ran${w.toward} until before the window close (switched off: ${forceChargeOffWords(cost.offReason)})`); /* MUTANT */",
    why: 'An OFF at 2:30am says "until before the window close (switched off: the run backstop)".',
  },
  {
    id: 'CNC-O-xiii. ★★★ an early OFF with no time names a clock',
    file: NOTIFY,
    find: RAN_OTHER,
    to: "          : `ran${w.toward} until ${phxShortClock(offAt ?? 0)} (switched off: ${forceChargeOffWords(cost.offReason)})`); /* MUTANT */",
    why: 'An OFF with no time on the record says "until 5pm (switched off: the run backstop)", a clock nothing recorded.',
  },
  {
    id: 'CNC-O-xiv. ★★★ an early OFF does not name its cause',
    file: NOTIFY,
    find: RAN_OTHER,
    to: "          : `ran${w.toward} until ${offAt != null ? phxShortClock(offAt) : 'before the window close'}`); /* MUTANT */",
    why: '"ran toward ~56.7% until 2:30am", with nothing of what switched it off.',
  },
  {
    id: 'CNC-O-xv. ★★★ an early OFF prints the record\'s reason code',
    file: NOTIFY,
    find: RAN_OTHER,
    to: "          : `ran${w.toward} until ${offAt != null ? phxShortClock(offAt) : 'before the window close'} (switched off: ${cost.offReason})`); /* MUTANT */",
    why: '"(switched off: maxRun)" in place of "(switched off: the run backstop)".',
  },

  /* ── R: the ON re-issues ── */
  {
    id: 'CNC-R-i. ★★★ the re-issues are never counted',
    file: NOTIFY,
    find: REISSUES,
    to: "  const reissues: number = 0; /* MUTANT */",
    why: 'A failed ON that was re-issued says "with no re-issue of the ON"; a verified one says nothing of it.',
  },
  {
    id: 'CNC-R-ii. ★★★ one re-issue is not counted',
    file: NOTIFY,
    find: REISSUES,
    to: "  const reissues = Number.isInteger(cost.onReissues) && cost.onReissues > 1 ? cost.onReissues : 0; /* MUTANT */",
    why: 'One re-issue (the most the add-on makes) is told as "with no re-issue of the ON".',
  },
  {
    id: 'CNC-R-iii. ★★★ a count that is no whole number is taken',
    file: NOTIFY,
    find: REISSUES,
    to: "  const reissues = cost.onReissues > 0 ? cost.onReissues : 0; /* MUTANT */",
    why: '"(after 1.5 re-issues of the ON)", "(after Infinity re-issues of the ON)".',
  },
  {
    id: 'CNC-R-iv. ★★★ the singular is gone',
    file: NOTIFY,
    find: REISSUE_WORDS,
    to: "  const reissueWords = `${reissues} re-issues of the ON`; /* MUTANT */",
    why: '"after 1 re-issues of the ON".',
  },
  {
    id: 'CNC-R-v. ★★★ the plural is gone',
    file: NOTIFY,
    find: REISSUE_WORDS,
    to: "  const reissueWords = 'one re-issue of the ON'; void reissues; /* MUTANT */",
    why: 'Two re-issues are told as "one re-issue of the ON".',
  },
  {
    id: 'CNC-R-vi. ★★★ a verified night never says its ON was re-issued',
    file: NOTIFY,
    find: RAN_NIGHT,
    to: "      night: `${w.reserve}, and force-charge ${ran}${close}${w.note}; ${w.restored}`, /* MUTANT */",
    why: '"force-charge reached ~56.7% at 3:12am and was switched off there; the pool read…" on a night whose ON took a re-issue.',
  },
  {
    id: 'CNC-R-vii. ★★★ a verified night always names a re-issue count',
    file: NOTIFY,
    find: RAN_NIGHT,
    to: "      night: `${w.reserve}, and force-charge ${ran} (after ${reissueWords})${close}${w.note}; ${w.restored}`, /* MUTANT */",
    why: '"(after 0 re-issues of the ON)" on every night whose ON took at once.',
  },
  {
    id: 'CNC-R-viii. ★★★ a failed night always says "with no re-issue"',
    file: NOTIFY,
    find: FAILED_NIGHT,
    to: "      night: `${w.reserve}${w.note}; force-charge${w.toward} ${w.failedOn}, with no re-issue of the ON${close}; ${w.restored}`, /* MUTANT */",
    why: 'An ON that was re-issued once and still did not take effect says "with no re-issue of the ON".',
  },
  {
    id: 'CNC-R-ix. ★★★ a failed night always says "after N re-issues"',
    file: NOTIFY,
    find: FAILED_NIGHT,
    to: "      night: `${w.reserve}${w.note}; force-charge${w.toward} ${w.failedOn}, after ${reissueWords}${close}; ${w.restored}`, /* MUTANT */",
    why: 'The 2026-11-16 night says "after 0 re-issues of the ON".',
  },
  {
    id: 'CNC-R-x. ★★★ a failed night says nothing of the re-issue',
    file: NOTIFY,
    find: FAILED_NIGHT,
    to: "      night: `${w.reserve}${w.note}; force-charge${w.toward} ${w.failedOn}${close}; ${w.restored}`, /* MUTANT */",
    why: '"was switched ON but did not take effect on slot(s) 2, 3 (…); the pool read 49% at the close": whether the ON was sent again goes unsaid.',
  },
  {
    id: 'CNC-R-xi. ★★★ an unconfirmed night never says its ON was re-issued',
    file: NOTIFY,
    find: UNCONF_NIGHT,
    to: "    night: `${w.reserve}${w.note}; force-charge${w.toward} was switched ON but the panel never confirmed it${close}; ${w.restored}`, /* MUTANT */",
    why: '"was switched ON but the panel never confirmed it; the pool read 52% at the close" on a night whose ON took a re-issue.',
  },
  {
    id: 'CNC-R-xii. ★★★ an unconfirmed night always names a re-issue count',
    file: NOTIFY,
    find: UNCONF_NIGHT,
    to: "    night: `${w.reserve}${w.note}; force-charge${w.toward} was switched ON but the panel never confirmed it, after ${reissueWords}${close}; ${w.restored}`, /* MUTANT */",
    why: '"the panel never confirmed it, after 0 re-issues of the ON".',
  },

  /* ── K: each shape's own words ── */
  {
    id: 'CNC-K-i. ★★★ a night whose force-charge ran states no close',
    file: NOTIFY,
    find: RAN_NIGHT,
    to: "      night: `${w.reserve}, and force-charge ${ran}${reissues > 0 ? ` (after ${reissueWords})` : ''}${w.note}; ${w.restored}`, /* MUTANT */",
    why: '"force-charge ran toward ~56.7% until the window close (~6.2 kWh expected); the reserve is restored": where the pool closed goes unsaid.',
  },
  {
    id: 'CNC-K-ii. ★★★ the expected figure is gone beside a force-charge that ran',
    file: NOTIFY,
    find: RAN_NIGHT,
    to: "      night: `${w.reserve}, and force-charge ${ran}${reissues > 0 ? ` (after ${reissueWords})` : ''}${close}; ${w.restored}`, /* MUTANT */",
    why: '"(~6.2 kWh expected)" is dropped from the one account it rides.',
  },
  {
    id: 'CNC-K-iii. ★★★ the expected figure is set ahead of the close',
    file: NOTIFY,
    find: RAN_NIGHT,
    to: "      night: `${w.reserve}, and force-charge ${ran}${reissues > 0 ? ` (after ${reissueWords})` : ''}${w.note}${close}; ${w.restored}`, /* MUTANT */",
    why: '"…and was switched off there (~6.2 kWh expected); the pool read 57% at the close…": the figure reads as the force-charge\'s own.',
  },
  {
    id: 'CNC-K-iv. ★★★ a start that never came states no close',
    file: NOTIFY,
    find: NEVER_NIGHT,
    to: "      night: `${w.reserve}${w.note}; force-charge${w.toward} never started${w.gridLost ? ' (the grid read as lost)' : ''}; ${w.restored}`, /* MUTANT */",
    why: '"closed without its force-charge: … never started; the reserve is restored": the 49% the pool closed at goes unsaid.',
  },
  {
    id: 'CNC-K-v. ★★★ the flagged never-started night drops the grid loss',
    file: NOTIFY,
    find: NEVER_NIGHT,
    to: "      night: `${w.reserve}${w.note}; force-charge${w.toward} never started${close}; ${w.restored}`, /* MUTANT */",
    why: '"never started; the pool read 49%…" on a night the grid read as lost: why it never started goes unsaid.',
  },
  {
    id: 'CNC-K-vi. ★★★ every flagged never-started night blames the grid',
    file: NOTIFY,
    find: NEVER_NIGHT,
    to: "      night: `${w.reserve}${w.note}; force-charge${w.toward} never started (the grid read as lost)${close}; ${w.restored}`, /* MUTANT */",
    why: '"never started (the grid read as lost)" on a night whose grid never read lost.',
  },
  {
    id: 'CNC-K-vii. ★★★ the flagged never-started night does not name its stop',
    file: NOTIFY,
    find: NEVER_NIGHT,
    to: "      night: `${w.reserve}${w.note}; force-charge never started${w.gridLost ? ' (the grid read as lost)' : ''}${close}; ${w.restored}`, /* MUTANT */",
    why: '"force-charge never started" with no "toward ~56.7%".',
  },
  {
    id: 'CNC-K-viii. ★★★ a failed night states no close',
    file: NOTIFY,
    find: FAILED_NIGHT,
    to: "      night: `${w.reserve}${w.note}; force-charge${w.toward} ${w.failedOn}, ${reissues > 0 ? `after ${reissueWords}` : 'with no re-issue of the ON'}; ${w.restored}`, /* MUTANT */",
    why: 'The 2026-11-16 night is flagged and still does not say it closed at 49% against the ~56.7% announced.',
  },
  {
    id: 'CNC-K-ix. ★★★ a failed night does not name its stop',
    file: NOTIFY,
    find: FAILED_NIGHT,
    to: "      night: `${w.reserve}${w.note}; force-charge ${w.failedOn}, ${reissues > 0 ? `after ${reissueWords}` : 'with no re-issue of the ON'}${close}; ${w.restored}`, /* MUTANT */",
    why: '"force-charge was switched ON but did not take effect" with no "toward ~56.7%".',
  },
  {
    id: 'CNC-K-x. ★★★ an unconfirmed night whose stop was read states no close',
    file: NOTIFY,
    find: UNCONF_REACHED_NIGHT,
    to: "      night: `${w.reserve}${w.note}; force-charge ${reached}, with no readback showing every slot ON; ${w.restored}`, /* MUTANT */",
    why: '"reached ~56.7% at 12:20am and was switched off there, with no readback showing every slot ON; the reserve is restored".',
  },
  {
    id: 'CNC-K-xi. ★★★ an ON never read back on every slot reads as a verified one',
    file: NOTIFY,
    find: UNCONF_REACHED_NIGHT,
    to: "      night: `${w.reserve}${w.note}; force-charge ${reached}${close}; ${w.restored}`, /* MUTANT */",
    why: '"force-charge reached ~56.7% at 12:20am and was switched off there; the pool read 57%…" with nothing of the missing readback.',
  },
  {
    id: 'CNC-K-xii. ★★★ an unconfirmed night states no close',
    file: NOTIFY,
    find: UNCONF_NIGHT,
    to: "    night: `${w.reserve}${w.note}; force-charge${w.toward} was switched ON but the panel never confirmed it${reissues > 0 ? `, after ${reissueWords}` : ''}; ${w.restored}`, /* MUTANT */",
    why: '"closed with its force-charge unconfirmed: … the panel never confirmed it; the reserve is restored".',
  },
  {
    id: 'CNC-K-xiii. ★★★ an unconfirmed night does not name its stop',
    file: NOTIFY,
    find: UNCONF_NIGHT,
    to: "    night: `${w.reserve}${w.note}; force-charge was switched ON but the panel never confirmed it${reissues > 0 ? `, after ${reissueWords}` : ''}${close}; ${w.restored}`, /* MUTANT */",
    why: '"force-charge was switched ON but the panel never confirmed it" with no "toward ~56.7%".',
  },

  /* ── F: the flag ── */
  {
    id: 'CNC-F-i. ★★★ a force-charge that ran is flagged',
    file: NOTIFY,
    find: RAN_NIGHT + NL + FLAG_NULL,
    to: RAN_NIGHT + NL + "      flagged: { lead: 'closed with its force-charge unconfirmed', title: 'force-charge not confirmed' }, /* MUTANT */",
    why: 'A verified night goes under "closed with its force-charge unconfirmed" and the title "force-charge not confirmed".',
  },
  {
    id: 'CNC-F-ii. ★★★ an announced start that never came is not flagged',
    file: NOTIFY,
    find: NEVER_FLAG,
    to: "      flagged: null, /* MUTANT */",
    why: '"completed", under "reserve restored to 16%", on a night whose announced force-charge never started.',
  },
  {
    id: 'CNC-F-iii. ★★★ the never-started lead reads "completed"',
    file: NOTIFY,
    find: NEVER_FLAG,
    to: "      flagged: { lead: 'completed', title: 'force-charge did not run' }, /* MUTANT */",
    why: 'The title says "force-charge did not run" and the body opens "Supervised night charge for … completed".',
  },
  {
    id: 'CNC-F-iv. ★★★ the never-started title is the failed night\'s',
    file: NOTIFY,
    find: NEVER_FLAG,
    to: "      flagged: { lead: 'closed without its force-charge', title: 'force-charge did not take effect' }, /* MUTANT */",
    why: 'A force-charge that was never switched ON is titled "force-charge did not take effect".',
  },
  {
    id: 'CNC-F-v(a). ★★★ an ON that did not take effect on some slots is not flagged (the 2026-11-16 defect)',
    file: NOTIFY,
    find: FAILED_FLAG_SOME,
    to: "        ? null /* MUTANT */",
    why: 'A top-up two slots never took goes under "completed" and "Night-charge: reserve restored to 16%".',
  },
  {
    id: 'CNC-F-v(b). ★★★ an ON that did not take effect on any slot is not flagged',
    file: NOTIFY,
    find: FAILED_FLAG_ALL,
    to: "        : null, /* MUTANT */",
    why: '"completed", under "reserve restored to 16%", on a night whose force-charge took effect on no slot.',
  },
  {
    id: 'CNC-F-vi. ★★★ a failure on some slots is told as one on every slot',
    file: NOTIFY,
    find: FAILED_FLAG_IF,
    to: "      flagged: fc.partialSlots != null && fc.partialSlots.length < 0 /* MUTANT */",
    why: 'A failure on slots 2 and 3 goes under "closed without its force-charge" and "force-charge did not take effect".',
  },
  {
    id: 'CNC-F-vii. ★★★ a failure on every slot is told as one on some',
    file: NOTIFY,
    find: FAILED_FLAG_IF + NL + FAILED_FLAG_SOME,
    to: "      flagged: true /* MUTANT */\n        ? { lead: 'closed with its force-charge not applied on every slot', title: `force-charge not applied on slot(s) ${(fc.partialSlots ?? []).join(', ')}` }",
    why: 'A whole-night failure goes under "not applied on every slot" and a title that names no slot.',
  },
  {
    id: 'CNC-F-viii. ★★★ the partial failure\'s lead is the whole failure\'s',
    file: NOTIFY,
    find: FAILED_FLAG_SOME,
    to: "        ? { lead: 'closed without its force-charge', title: `force-charge not applied on slot(s) ${fc.partialSlots.join(', ')}` } /* MUTANT */",
    why: 'A night one slot charged on opens "closed without its force-charge".',
  },
  {
    id: 'CNC-F-ix. ★★★ the partial failure\'s title names no slot',
    file: NOTIFY,
    find: FAILED_FLAG_SOME,
    to: "        ? { lead: 'closed with its force-charge not applied on every slot', title: 'force-charge did not take effect' } /* MUTANT */",
    why: '"force-charge did not take effect — reserve restored to 16%" on a failure of slots 2 and 3 only.',
  },
  {
    id: 'CNC-F-x. ★★★ the partial failure\'s title names its first slot only',
    file: NOTIFY,
    find: FAILED_FLAG_SOME,
    to: "        ? { lead: 'closed with its force-charge not applied on every slot', title: `force-charge not applied on slot(s) ${fc.partialSlots[0]}` } /* MUTANT */",
    why: '"force-charge not applied on slot(s) 2" on a failure of slots 2 and 3.',
  },
  {
    id: 'CNC-F-xi. ★★★ the whole failure\'s lead is the partial one\'s',
    file: NOTIFY,
    find: FAILED_FLAG_ALL,
    to: "        : { lead: 'closed with its force-charge not applied on every slot', title: 'force-charge did not take effect' }, /* MUTANT */",
    why: 'A failure on every slot opens "not applied on every slot".',
  },
  {
    id: 'CNC-F-xii. ★★★ the whole failure\'s title is the never-started night\'s',
    file: NOTIFY,
    find: FAILED_FLAG_ALL,
    to: "        : { lead: 'closed without its force-charge', title: 'force-charge did not run' }, /* MUTANT */",
    why: 'An ON that was written, and did not take effect, is titled "force-charge did not run".',
  },
  {
    id: 'CNC-F-xiii. ★★★ an unconfirmed night ignores a stop that was read',
    file: NOTIFY,
    find: REACHED_BRANCH,
    to: "  if (reached != null && false) { /* MUTANT */",
    why: 'A short top-up that read its stop before every slot read ON says "was switched ON but the panel never confirmed it" under "force-charge not confirmed".',
  },
  {
    id: 'CNC-F-xiv. ★★★ an unconfirmed night whose stop was read is flagged',
    file: NOTIFY,
    find: UNCONF_REACHED_NIGHT + NL + FLAG_NULL,
    to: UNCONF_REACHED_NIGHT + NL + "      flagged: { lead: 'closed with its force-charge unconfirmed', title: 'force-charge not confirmed' }, /* MUTANT */",
    why: '"closed with its force-charge unconfirmed: … reached ~56.7% at 12:20am and was switched off there".',
  },
  {
    id: 'CNC-F-xv. ★★★ an ON never confirmed short of its stop is not flagged',
    file: NOTIFY,
    find: UNCONF_FLAG,
    to: "    flagged: null, /* MUTANT */",
    why: '"completed", under "reserve restored to 16%", on a night whose ON the panel never confirmed.',
  },
  {
    id: 'CNC-F-xvi. ★★★ the unconfirmed lead claims no force-charge',
    file: NOTIFY,
    find: UNCONF_FLAG,
    to: "    flagged: { lead: 'closed without its force-charge', title: 'force-charge not confirmed' }, /* MUTANT */",
    why: 'An ON that may have taken opens "closed without its force-charge".',
  },
  {
    id: 'CNC-F-xvii. ★★★ the unconfirmed title is the failed night\'s',
    file: NOTIFY,
    find: UNCONF_FLAG,
    to: "    flagged: { lead: 'closed with its force-charge unconfirmed', title: 'force-charge did not take effect' }, /* MUTANT */",
    why: 'An ON nothing read back is titled "force-charge did not take effect".',
  },
  {
    id: 'CNC-F-xviii. ★★★ an unconfirmed ON is told as a force-charge that ran',
    file: NOTIFY,
    find: KIND_RAN,
    to: "  if (fc.kind === 'ran' || fc.kind === 'unconfirmed') { /* MUTANT */",
    why: '"reserve raised to 50%, and force-charge ran toward ~56.7%", under "completed", on an ON the panel never confirmed.',
  },
  {
    id: 'CNC-F-xix. ★★★ a start that never came is told as an unconfirmed ON',
    file: NOTIFY,
    find: KIND_NEVER,
    to: "  if (fc.kind === 'neverStarted' && false) { /* MUTANT */",
    why: '"was switched ON but the panel never confirmed it", under "force-charge not confirmed", on a night nothing was switched ON.',
  },
  {
    id: 'CNC-F-xx. ★★★ a failed ON is told as an unconfirmed one',
    file: NOTIFY,
    find: KIND_FAILED,
    to: "  if (fc.kind === 'failed' && reissues < 0) { /* MUTANT */",
    why: '"the panel never confirmed it", under "force-charge not confirmed", on an ON the readback showed not applied.',
  },

  /* ── B: the builder's block ── */
  {
    id: 'CNC-B-i. ★★★ the flag does not start null',
    file: NOTIFY,
    find: FLAGGED_INIT,
    to: "  let flagged: { lead: string; title: string } | null = { lead: 'completed', title: 'force-charge did not run' }; /* MUTANT */",
    why: 'Every summary with no close account (a reserve-only night, a line night, every text of v1.208.0) is titled "force-charge did not run — reserve restored to 16%".',
  },
  {
    id: 'CNC-B-ii. ★★★ the account is read on a night whose input carries a line',
    file: NOTIFY,
    find: COST_IF,
    to: "    const costAccount = line == null /* MUTANT */",
    why: 'A cost-dominant night says "against the ~90% the evening notice named" in place of "the pool read 62% at the close, under the 69.4% outage line".',
  },
  {
    id: 'CNC-B-iii. ★★★ the account is read on a night whose outcome carries a line',
    file: NOTIFY,
    find: COST_IF,
    to: "    const costAccount = linePct == null /* MUTANT */",
    why: 'An outcome line with no usable level hands the night to the cost account: flagged, "against the ~56.7% the evening notice named", and the line night\'s own account (the panel\'s stop, the re-ONs) gone.',
  },
  {
    id: 'CNC-B-iv. ★★★ the account is read only on a night with a line',
    file: NOTIFY,
    find: COST_IF,
    to: "    const costAccount = linePct != null /* MUTANT */",
    why: 'A cost night keeps the words of v1.208.0 ("completed"), and a cost-dominant night (a line on its record) takes the cost close.',
  },
  {
    id: 'CNC-B-v. ★★★ the close account is not handed on',
    file: NOTIFY,
    find: COST_CALL,
    to: "      ? costNightAccount(null, fc, { reserve, toward, note, restored, failedOn, gridLost: o.gridLost === true }) : null; /* MUTANT */",
    why: 'The 2026-11-16 night again: "completed", "reserve restored to 16%", no close stated.',
  },
  {
    id: 'CNC-B-vi. ★★★ the account is handed "reserve raised" whatever the reserve did',
    file: NOTIFY,
    find: COST_CALL,
    to: "      ? costNightAccount(o.cost, fc, { reserve: `reserve raised to ${raised}`, toward, note, restored, failedOn, gridLost: o.gridLost === true }) : null; /* MUTANT */",
    why: 'A night whose reserve stood, or was held as a floor, says "reserve raised to 50%".',
  },
  {
    id: 'CNC-B-vii. ★★★ the account is handed no stop words',
    file: NOTIFY,
    find: COST_CALL,
    to: "      ? costNightAccount(o.cost, fc, { reserve, toward: '', note, restored, failedOn, gridLost: o.gridLost === true }) : null; /* MUTANT */",
    why: '"force-charge ran; the pool read…", "force-charge never started": the ~56.7% stop goes unnamed.',
  },
  {
    id: 'CNC-B-viii. ★★★ the account is handed no expected figure',
    file: NOTIFY,
    find: COST_CALL,
    to: "      ? costNightAccount(o.cost, fc, { reserve, toward, note: '', restored, failedOn, gridLost: o.gridLost === true }) : null; /* MUTANT */",
    why: '"(~6.2 kWh expected)" is dropped from a night whose force-charge ran.',
  },
  {
    id: 'CNC-B-ix. ★★★ the account is handed "restored" whatever the restore did',
    file: NOTIFY,
    find: COST_CALL,
    to: "      ? costNightAccount(o.cost, fc, { reserve, toward, note, restored: `the reserve is restored to ${o.restorePct}%. `, failedOn, gridLost: o.gridLost === true }) : null; /* MUTANT */",
    why: '"the reserve is restored to 16%" on a restore the panel has not read back, and on a night no restore was due.',
  },
  {
    id: 'CNC-B-x. ★★★ the account is handed the whole-failure words',
    file: NOTIFY,
    find: COST_CALL,
    to: "      ? costNightAccount(o.cost, fc, { reserve, toward, note, restored, failedOn: 'was switched ON but did not take effect', gridLost: o.gridLost === true }) : null; /* MUTANT */",
    why: 'The body of a failure on slots 2 and 3 says "was switched ON but did not take effect", with no slot named.',
  },
  {
    id: 'CNC-B-xi. ★★★ the account is not handed the grid loss',
    file: NOTIFY,
    find: COST_CALL,
    to: "      ? costNightAccount(o.cost, fc, { reserve, toward, note, restored, failedOn, gridLost: false }) : null; /* MUTANT */",
    why: 'A flagged never-started night drops "(the grid read as lost)".',
  },
  {
    id: 'CNC-B-xii. ★★★ a grid loss nothing read is handed on',
    file: NOTIFY,
    find: COST_CALL,
    to: "      ? costNightAccount(o.cost, fc, { reserve, toward, note, restored, failedOn, gridLost: o.gridLost !== false }) : null; /* MUTANT */",
    why: '"never started (the grid read as lost)" on a record with no grid loss on it.',
  },
  {
    id: 'CNC-B-xiii. ★★★ only a flagged account is taken',
    file: NOTIFY,
    find: ACCOUNT_IF,
    to: "    if (costAccount != null && costAccount.flagged != null) { /* MUTANT */",
    why: 'A night whose force-charge ran keeps the words of v1.208.0: no close, no "reached", no re-issue.',
  },
  {
    id: 'CNC-B-xiv. ★★★ the flag is taken and the account is not',
    file: NOTIFY,
    find: NIGHT_SET,
    to: "      /* MUTANT */",
    why: '"closed with its force-charge not applied on every slot" over the words of v1.208.0: no close and no re-issue stated, and a night that ran states none either.',
  },
  {
    id: 'CNC-B-xv. ★★★ the account is taken and the flag is not',
    file: NOTIFY,
    find: FLAG_SET,
    to: "      flagged = costAccount.flagged != null && costAccount.night === '' ? costAccount.flagged : null; /* MUTANT */",
    why: 'The 2026-11-16 account goes out under "completed" and "Night-charge: reserve restored to 16%".',
  },
  {
    id: 'CNC-B-xvi. ★★★ an unflagged account takes the flagged return',
    file: NOTIFY,
    find: FLAG_SET,
    to: "      flagged = costAccount.flagged ?? { lead: 'completed', title: 'completed' }; /* MUTANT */",
    why: 'A night whose force-charge ran is titled "Night-charge: completed — reserve restored to 16%".',
  },
  {
    id: 'CNC-B-xvii. ★★★ the flagged return is never taken',
    file: NOTIFY,
    find: FLAG_IF,
    to: "  if (flagged != null && flagged.lead === '') { /* MUTANT */",
    why: 'A flagged account goes out under "completed" and the plain restore title.',
  },
  {
    id: 'CNC-B-xviii. ★★★ a flagged account goes out as a warning',
    file: NOTIFY,
    find: FLAG_IF + NL + FLAG_RETURN_HEAD,
    to: FLAG_IF + NL + FLAG_RETURN_HEAD + " severity: 'warning' as const, /* MUTANT */",
    why: 'The morning summary of a flagged night is delivered at another severity than the summary it stands for.',
  },
  {
    id: 'CNC-B-xix. ★★★ a flagged account takes a card of its own',
    file: NOTIFY,
    find: FLAG_IF + NL + FLAG_RETURN_HEAD,
    to: FLAG_IF + NL + FLAG_RETURN_HEAD + " dedupId: 'night_charge_flagged', /* MUTANT */",
    why: 'A flagged summary no longer replaces the night\'s actuation card: two cards stand for one night.',
  },
  {
    id: 'CNC-B-xx. ★★★ the flagged title claims a restore on a reserve that stood',
    file: NOTIFY,
    find: FLAG_TITLE,
    to: "      title: `Night-charge: ${flagged.title} — ${titleRestore}`, /* MUTANT */",
    why: '"force-charge did not run — reserve restored to 16%" on a night with no write and no restore.',
  },
  {
    id: 'CNC-B-xxi. ★★★ the flagged title drops how the reserve was left',
    file: NOTIFY,
    find: FLAG_TITLE,
    to: "      title: `Night-charge: ${flagged.title}`, /* MUTANT */",
    why: '"Night-charge: force-charge not applied on slot(s) 2, 3", with nothing of the restore.',
  },
  {
    id: 'CNC-B-xxii. ★★★ the flagged title says "restored" of a restore not read back',
    file: NOTIFY,
    find: FLAG_TITLE,
    to: "      title: `Night-charge: ${flagged.title} — ${stood ? `reserve stood at ${raised}` : `reserve restored to ${o.restorePct}%`}`, /* MUTANT */",
    why: '"force-charge did not run — reserve restored to 16%" while the panel has not read the restore back.',
  },
  {
    id: 'CNC-B-xxiii. ★★★ the flagged title\'s standing test is inverted',
    file: NOTIFY,
    find: FLAG_TITLE,
    to: "      title: `Night-charge: ${flagged.title} — ${stood ? titleRestore : `reserve stood at ${raised}`}`, /* MUTANT */",
    why: '"force-charge did not run — reserve stood at 50%" on a night whose reserve was restored to 16%.',
  },
  {
    id: 'CNC-B-xxiv. ★★★ the flagged body opens "completed"',
    file: NOTIFY,
    find: FLAG_BODY,
    to: "        `Supervised night charge for ${day} completed: ${night}` /* MUTANT */",
    why: 'The title says "force-charge did not take effect" and the body opens "Supervised night charge for … completed".',
  },
  {
    id: 'CNC-B-xxv. ★★★ the flagged body prints the record\'s day unguarded',
    file: NOTIFY,
    find: FLAG_BODY,
    to: "        `Supervised night charge for ${o.day} ${flagged.lead}: ${night}` /* MUTANT */",
    why: '"Supervised night charge for null closed without its force-charge" on a record with no day.',
  },
  {
    id: 'CNC-B-xxvi. ★★★ the flagged body drops the ledger sentence',
    file: NOTIFY,
    find: FLAG_BODY + NL + FLAG_LEDGER,
    to: FLAG_BODY + ", /* MUTANT */",
    why: 'A flagged account ends at the restore: "Delivery vs plan scores in the ledger at tomorrow evening\'s update." is gone.',
  },

  /* ── X: the wiring (index.ts sendRestoreSummary) ── */
  {
    id: 'CNC-X-i. ★★★ `cost` is passed only on a night whose record carries a line',
    file: INDEX,
    find: COST_GUARD,
    to: "      cost: lineNight != null ? { /* MUTANT */",
    why: 'No cost night gets a close account: every one goes out in the words of v1.208.0, "completed".',
  },
  {
    id: 'CNC-X-ii. ★★★ `cost` is passed on every night',
    file: INDEX,
    find: COST_GUARD,
    to: "      cost: lineNight == null || true ? { /* MUTANT */",
    why: 'A line night is handed a cost close account: only the builder\'s own guard stands between it and "against the ~L% the evening notice named".',
  },
  {
    id: 'CNC-X-iii. ★★★ the announced level is the written reserve',
    file: INDEX,
    find: COST_L1,
    to: "        announcedLevelPct: state.targetPct, poolPct: freshPoolSocPct(nowMs), readLate: lineCloseReadingLate(state, nowMs), /* MUTANT */",
    why: '"against the ~50% the evening notice named" on a night announced at 56.7%, and a start that never came is never flagged.',
  },
  {
    id: 'CNC-X-iv. ★★★ the announced level is the force-charge ceiling',
    file: INDEX,
    find: COST_L1,
    to: "        announcedLevelPct: state.forceChargeCeilingPct, poolPct: freshPoolSocPct(nowMs), readLate: lineCloseReadingLate(state, nowMs), /* MUTANT */",
    why: 'The armed economic ceiling is told as the level "the evening notice named", whatever the notice said, and the start-announced test is made against it.',
  },
  {
    id: 'CNC-X-v. ★★★ no announced level is passed',
    file: INDEX,
    find: COST_L1,
    to: "        announcedLevelPct: null, poolPct: freshPoolSocPct(nowMs), readLate: lineCloseReadingLate(state, nowMs), /* MUTANT */",
    why: '"the pool read 49% at the close" with no level beside it, and a start that never came is never flagged.',
  },
  {
    id: 'CNC-X-vi. ★★★ no reading is passed',
    file: INDEX,
    find: COST_L1,
    to: "        announcedLevelPct: state.announcedLevelPct, poolPct: null, readLate: lineCloseReadingLate(state, nowMs), /* MUTANT */",
    why: 'Every cost night says "the pool was not read at the close (no fresh panel reading)".',
  },
  {
    id: 'CNC-X-vii. ★★★ the reading is the announced level',
    file: INDEX,
    find: COST_L1,
    to: "        announcedLevelPct: state.announcedLevelPct, poolPct: state.announcedLevelPct, readLate: lineCloseReadingLate(state, nowMs), /* MUTANT */",
    why: '"the pool read 56.7% at the close, against the ~56.7% the evening notice named" on a night that closed at 49%.',
  },
  {
    id: 'CNC-X-viii. ★★★ the reading is never late',
    file: INDEX,
    find: COST_L1,
    to: "        announcedLevelPct: state.announcedLevelPct, poolPct: freshPoolSocPct(nowMs), readLate: false, /* MUTANT */",
    why: 'A summary sent hours after the close (the process down across it) says "the pool read X% at the close".',
  },
  {
    id: 'CNC-X-ix. ★★★ "late" keeps the line night\'s gate',
    file: INDEX,
    find: COST_L1,
    to: "        announcedLevelPct: state.announcedLevelPct, poolPct: freshPoolSocPct(nowMs), readLate: lineNight != null && lineCloseReadingLate(state, nowMs), /* MUTANT */",
    why: 'The gate of the line night\'s closeReadLate, copied: never late on the nights this account is for.',
  },
  {
    id: 'CNC-X-x. ★★★ no OFF reason is passed',
    file: INDEX,
    find: COST_L2,
    to: "        offReason: null, offAtMs: state.forceChargeOffAtMs, onReissues: state.forceChargeOnRetries, /* MUTANT */",
    why: 'Every verified night says "ran toward ~S%": a target OFF is never "reached", an early OFF names no cause.',
  },
  {
    id: 'CNC-X-xi. ★★★ the OFF reason is the force-charge mode',
    file: INDEX,
    find: COST_L2,
    to: "        offReason: state.forceChargeMode, offAtMs: state.forceChargeOffAtMs, onReissues: state.forceChargeOnRetries, /* MUTANT */",
    why: '"ran toward ~56.7% until 3:12am (switched off: cost)".',
  },
  {
    id: 'CNC-X-xii. ★★★ no OFF time is passed',
    file: INDEX,
    find: COST_L2,
    to: "        offReason: state.forceChargeOffReason, offAtMs: null, onReissues: state.forceChargeOnRetries, /* MUTANT */",
    why: 'A target OFF is never "reached ~S% at <clock>"; an early OFF says "until before the window close".',
  },
  {
    id: 'CNC-X-xiii. ★★★ the OFF time is the ON\'s',
    file: INDEX,
    find: COST_L2,
    to: "        offReason: state.forceChargeOffReason, offAtMs: state.forceChargeOnAtMs, onReissues: state.forceChargeOnRetries, /* MUTANT */",
    why: '"reached ~56.7% at <the clock the ON was written>" for a stop read hours later.',
  },
  {
    id: 'CNC-X-xiv. ★★★ no re-issue is passed',
    file: INDEX,
    find: COST_L2,
    to: "        offReason: state.forceChargeOffReason, offAtMs: state.forceChargeOffAtMs, onReissues: 0, /* MUTANT */",
    why: 'An ON that was re-issued and still did not take effect says "with no re-issue of the ON".',
  },
  {
    id: 'CNC-X-xv. ★★★ the re-issues are the OFF\'s retries',
    file: INDEX,
    find: COST_L2,
    to: "        offReason: state.forceChargeOffReason, offAtMs: state.forceChargeOffAtMs, onReissues: state.forceChargeOffRetries, /* MUTANT */",
    why: 'A retried OFF is told as "after one re-issue of the ON".',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs). Each mutant runs the whole
// subset, with its failing tests named; the subset alone decides.
import { runMutantsParallel } from './lib/mutateParallel.mjs';
await runMutantsParallel({
  name: 'mutate-cost-night-close', mutants: MUTANTS.map((m) => ({ ...m, tests: SUBSET })), subset: SUBSET, root: REPO,
  perMutantTests: true, typecheck: true, fullSuite: false,
});
