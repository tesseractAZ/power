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
 * (T) THE CLOCK OF THE OFF: printed only for a time that is finite and within ±8.64e15 ms (each half of the bound, the bound
 *     itself inclusive); any other time is no time, and nothing throws.
 * (S) "AT ITS STOP": the OFF reason 'target' alone, with or without a time, on every shape that reads it (the words of a
 *     night that ran, the stop sentence and the flag of a failed night, the branch of an unconfirmed one); never the close
 *     reading.
 * (O) WHAT ENDED A FORCE-CHARGE THAT RAN: "reached ~S%[ at CLOCK]" at its stop; the window-end OFF; no OFF reason; any
 *     other OFF "and was switched off at CLOCK (WORDS)", or "before the window close (WORDS)" with no clock.
 * (E) WHAT ENDED A FORCE-CHARGE THAT FAILED OR WAS NEVER CONFIRMED: at its stop "; the pool read ~S%[ at CLOCK] and the
 *     force-charge was switched off there" (failed); any other early OFF "; it was switched off at CLOCK (WORDS)", or
 *     "before the window close (WORDS)"; nothing for a window-end OFF or none.
 * (R) THE ON RE-ISSUES: a count is usable only as a non-negative whole number; "one re-issue" and "N re-issues", in a comma
 *     clause on each shape and never a bracket; on a failed night said where made, its absence said where none was made, and
 *     nothing said where the count is unusable; the place of the clause on each shape.
 * (N) A START THAT NEVER CAME AND WAS NOT NEEDED: not flagged only where the reading is present, not late, and at or above
 *     the stop — the reading as read against the stop as armed, neither rounded.
 * (K) EACH SHAPE'S OWN WORDS: the close clause on every shape; the expected figure beside the charge's own phrase on each
 *     form of a force-charge that ran, ahead of the close clause; the grid read as lost; the stop named; "with no readback
 *     showing every slot ON"; the failed slots in the body.
 * (P) THE FAILED-SLOT LIST: a list that names at least one slot is a failure on some slots; null or empty is every slot.
 * (F) THE FLAG: null on a force-charge that ran and on an unconfirmed one at its stop; the lead and the title of a start
 *     that never came, of an ON that failed on some slots, on every slot at its stop and on every slot otherwise, and of an
 *     ON never confirmed short of its stop (an early OFF included, whatever the close reads).
 * (L) THE SLOTS LEFT OUT (cost.leftOutSlots): read only from a list, positive whole numbers only; named after the
 *     force-charge clause and ahead of the close clause on a night that ran, failed or was never confirmed; never on a
 *     night that never started.
 * (B) THE BUILDER'S BLOCK: the account read only where neither the input nor the outcome carries a line; the five words
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
 * Two mutants of the first draft are gone, each because the correction reversed its property: O-iv ("reached" needs no OFF
 * time — now the rule; its reverse is S-i and S-iii to S-vi) and K-iii (the expected figure ahead of the close — now the
 * rule; its reverse is K-iii(a) to (g)). B-x (the builder hands the whole-failure words) is K-xiv: the failed words are
 * the account's own now.
 *
 * Not written, because no typed input tells them apart: the `!= null` half beside each Number.isFinite test (the stop, the
 * announced level, the reading, the OFF time: Number.isFinite(null) is false); `announced != null` in the start test (null ===
 * stop is false); `!atStop` in the early-OFF test (every reader of the early OFF sits behind an at-its-stop test of its
 * own); `=== 1` against `<= 1` in the re-issue words (they are read only behind `reissues > 0`); `=== true` against a
 * truthy test of readLate (a boolean); `${w.note}` on the four shapes other than "ran" (the builder passes '' there).
 *
 * Written, though no record of the add-on's tells them apart: B-iii (the `line == null` half), held by an outcome line
 * with no level beside the source check; T-i (the finite test of the clock guard), held by a time that is no number — a
 * digit string, `true` — since the bound already refuses NaN and the infinities; P-i (an empty failed-slot list), R-iii
 * to R-iii(b) and R-ii(b) (a re-issue count that is no count) and L-i to L-iv (a left-out list that is no list, or names
 * what is no slot), each held by the damaged-record cases of test/costNightClose.test.ts.
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
const MAX_DATE = "const MAX_DATE_MS = 8.64e15;";
const GUARD = "  if (cost == null || fc.stopPct == null || !Number.isFinite(fc.stopPct)) return null;";
const STOP = "  const stop = round1(fc.stopPct);";
const ANNOUNCED = "  const announced = cost.announcedLevelPct != null && Number.isFinite(cost.announcedLevelPct) ? round1(cost.announcedLevelPct) : null;";
const START = "  const startAnnounced = announced != null && announced === stop;";
const NEVER_GUARD = "  if (fc.kind === 'neverStarted' && !startAnnounced) return null;";
const POOL_READ = "  const poolRead = cost.poolPct != null && Number.isFinite(cost.poolPct) ? cost.poolPct : null;";
const READ = "  const read = poolRead != null ? round1(poolRead) : null;";
const NAMED_AFTER = "  const namedAfter = announced != null ? `; the evening notice named ~${announced}%` : '';";
const UNREAD = "  const close = read == null ? `; the pool was not read at the close (no fresh panel reading)${namedAfter}`";
const LATE = "    : cost.readLate === true ? `; the pool reads ${read}% now, past the window close${namedAfter}`";
const AT_CLOSE = "      : `; the pool read ${read}% at the close${announced != null ? `, against the ~${announced}% the evening notice named` : ''}`;";
const OFF_CLOCK_IF = "  const offClock = cost.offAtMs != null && Number.isFinite(cost.offAtMs) && Math.abs(cost.offAtMs) <= MAX_DATE_MS";
const AT_STOP = "  const atStop = cost.offReason === 'target';";
const EARLY_IF = "  const earlyOff = cost.offReason != null && cost.offReason !== 'windowEnd' && !atStop";
const EARLY_WORDS = "    ? ` ${offClock != null ? `at ${offClock}` : 'before the window close'} (${forceChargeOffWords(cost.offReason)})` : null;";
const REISSUES_KNOWN = "  const reissuesKnown = Number.isInteger(cost.onReissues) && cost.onReissues >= 0;";
const REISSUES = "  const reissues = reissuesKnown ? cost.onReissues : 0;";
const REISSUE_WORDS = "  const reissueWords = reissues === 1 ? 'one re-issue of the ON' : `${reissues} re-issues of the ON`;";
const AFTER_REISSUE = "  const afterReissue = reissues > 0 ? `, after ${reissueWords}` : '';";
const LEFT_OUT = "  const leftOut = Array.isArray(cost.leftOutSlots) ? cost.leftOutSlots.filter((n) => Number.isInteger(n) && n >= 1) : [];";
const LEFT_OUT_IF = "  const leftOutWords = leftOut.length > 0";
const LEFT_OUT_WORDS = "    ? `; slot(s) ${leftOut.join(', ')} not switched on (named out of the backup pool by the pool alarm)` : '';";
const REACHED_WORDS = "  const reachedWords = `reached ~${stop}%${offClock != null ? ` at ${offClock}` : ''} and was switched off there`;";
const KIND_RAN = "  if (fc.kind === 'ran') {";
const RAN_STOP = "    const ran = atStop ? `${reachedWords}${afterReissue}${w.note}`";
const RAN_NONE = "      : cost.offReason == null ? `ran${w.toward}${afterReissue}${w.note}`";
const RAN_WINDOW = "        : earlyOff == null ? `ran${w.toward} until the window close${afterReissue}${w.note}`";
const RAN_EARLY = "          : `ran${w.toward}${w.note} and was switched off${earlyOff}${afterReissue}`;";
const RETURN_OPEN = "    return {";
const RAN_NIGHT = "      night: `${w.reserve}, and force-charge ${ran}${leftOutWords}${close}; ${w.restored}`,";
const FLAG_NULL = "      flagged: null,";
const KIND_NEVER = "  if (fc.kind === 'neverStarted') {";
const NOT_NEEDED = "    const notNeeded = poolRead != null && cost.readLate !== true && poolRead >= fc.stopPct;";
const NEVER_NIGHT = "      night: `${w.reserve}${w.note}; force-charge${w.toward} never started${w.gridLost ? ' (the grid read as lost)' : ''}${close}; ${w.restored}`,";
const NEVER_FLAG = "      flagged: notNeeded ? null : { lead: 'closed without its force-charge', title: 'force-charge did not run' },";
const KIND_FAILED = "  if (fc.kind === 'failed') {";
const PARTIAL = "    const partial = fc.partialSlots != null && fc.partialSlots.length > 0;";
const FAILED_WORDS_STOP = "    const failedWords = !partial && atStop ? 'was switched ON and its readback check failed' : partial";
const FAILED_WORDS_SOME = "      ? `was switched ON but did not take effect on slot(s) ${fc.partialSlots!.join(', ')} (the buy above the reserve did not happen on those slot(s))`";
const FAILED_WORDS_ALL = "      : 'was switched ON but did not take effect';";
const REISSUE_FACT = "    const reissueFact = !reissuesKnown ? '' : reissues > 0 ? `, after ${reissueWords}` : ', with no re-issue of the ON';";
const ENDED_STOP = "    const ended = atStop ? `; the pool read ~${stop}%${offClock != null ? ` at ${offClock}` : ''} and the force-charge was switched off there`";
const ENDED_EARLY = "      : earlyOff != null ? `; it was switched off${earlyOff}` : '';";
const FAILED_NIGHT = "      night: `${w.reserve}${w.note}; force-charge${w.toward} ${failedWords}${reissueFact}${ended}${leftOutWords}${close}; ${w.restored}`,";
const FAILED_FLAG_IF = "      flagged: partial";
const FAILED_FLAG_SOME = "        ? { lead: 'closed with its force-charge not applied on every slot', title: `force-charge not applied on slot(s) ${fc.partialSlots!.join(', ')}` }";
const FAILED_FLAG_STOP_IF = "        : atStop";
const FAILED_FLAG_STOP = "          ? { lead: 'closed with its force-charge ON not confirmed', title: 'force-charge ON not confirmed' }";
const FAILED_FLAG_ALL = "          : { lead: 'closed without its force-charge', title: 'force-charge did not take effect' },";
const STOP_BRANCH = "  if (atStop) {";
const UNCONF_REACHED_NIGHT = "      night: `${w.reserve}${w.note}; force-charge ${reachedWords}, with no readback showing every slot ON${afterReissue}${leftOutWords}${close}; ${w.restored}`,";
const UNCONF_NIGHT = "    night: `${w.reserve}${w.note}; force-charge${w.toward} was switched ON but the panel never confirmed it${afterReissue}${earlyOff != null ? `; it was switched off${earlyOff}` : ''}${leftOutWords}${close}; ${w.restored}`,";
const UNCONF_FLAG = "    flagged: { lead: 'closed with its force-charge unconfirmed', title: 'force-charge not confirmed' },";

/* buildNightChargeMorningSummary (notify.ts): the lines v1.209.0 added. */
const FLAGGED_INIT = "  let flagged: { lead: string; title: string } | null = null;";
const COST_IF = "    const costAccount = linePct == null && line == null";
const COST_CALL = "      ? costNightAccount(o.cost, fc, { reserve, toward, note, restored, gridLost: o.gridLost === true }) : null;";
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

/* Fragments of the lines above that more than one mutant moves. */
const CLOCK_OPT = "${offClock != null ? ` at ${offClock}` : ''}";
const EARLY_OPT = "${earlyOff != null ? `; it was switched off${earlyOff}` : ''}";
const SWITCHED_OFF = "`; it was switched off${earlyOff}`";

/** A mutant's line: `line` with `from` (in it exactly once) replaced by `to`, and the marker. Throws on a fragment that is not there. */
const swap = (line, from, to) => {
  if (line.split(from).length !== 2) throw new Error(`swap: ${JSON.stringify(from)} is not in the line exactly once: ${line}`);
  return `${line.replace(from, () => to)} /* MUTANT */`;
};

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
    to: "  if (cost == null || (fc.stopPct != null && !Number.isFinite(fc.stopPct))) return null; /* MUTANT */\n  if (fc.stopPct == null) return costNightAccount(cost, { ...fc, stopPct: 0 }, w);\n  const stop = round1(fc.stopPct);",
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
    id: 'CNC-G-iv. ★★★ a never-started night takes the account whatever the evening notice named',
    file: NOTIFY,
    find: NEVER_GUARD,
    to: "  void startAnnounced; /* MUTANT */",
    why: 'A night whose notice expected no start (it named the 50% reserve) states a close, and goes under "closed without its force-charge" and the title "force-charge did not run".',
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
    to: "  const read = poolRead != null ? poolRead : null; /* MUTANT */",
    why: '"the pool read 61.26% at the close".',
  },
  {
    id: 'CNC-C-ii. ★★★ the reading is rounded to the whole percent',
    file: NOTIFY,
    find: READ,
    to: "  const read = poolRead != null ? Math.round(poolRead) : null; /* MUTANT */",
    why: 'A 61.26% reading is told as "61%" and a 48.94% one as "49%": one decimal of the panel\'s reading is dropped.',
  },
  {
    id: 'CNC-C-iii. ★★★ a non-finite reading is taken as a reading',
    file: NOTIFY,
    find: POOL_READ,
    to: "  const poolRead = cost.poolPct != null ? cost.poolPct : null; /* MUTANT */",
    why: '"the pool read NaN% at the close", and an Infinity reading leaves a start that never came unflagged.',
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

  /* ── T: the clock of the OFF ── */
  {
    id: 'CNC-O-i. ★★★ any OFF time on the record is taken as a clock',
    file: NOTIFY,
    find: OFF_CLOCK_IF,
    to: "  const offClock = cost.offAtMs != null /* MUTANT */",
    why: 'The clock formatter is handed NaN, or a time no Date holds: the builder throws, and the summary is never sent.',
  },
  {
    id: 'CNC-T-i. ★★★ the clock guard drops its finite test',
    file: NOTIFY,
    find: OFF_CLOCK_IF,
    to: swap(OFF_CLOCK_IF, ' && Number.isFinite(cost.offAtMs)', ''),
    why: 'A time kept as text, or as `true`, passes the bound: the formatter throws on the one and prints "5pm" for the other.',
  },
  {
    id: 'CNC-T-ii. ★★★ the clock guard drops its bound',
    file: NOTIFY,
    find: OFF_CLOCK_IF,
    to: swap(OFF_CLOCK_IF, ' && Math.abs(cost.offAtMs) <= MAX_DATE_MS', ''),
    why: 'An OFF time of 1e300 on a damaged record reaches the formatter: the builder throws, and the summary is never sent.',
  },
  {
    id: 'CNC-T-iii. ★★★ the bound holds only its upper half',
    file: NOTIFY,
    find: OFF_CLOCK_IF,
    to: swap(OFF_CLOCK_IF, 'Math.abs(cost.offAtMs) <= MAX_DATE_MS', 'cost.offAtMs <= MAX_DATE_MS'),
    why: 'An OFF time of -1e300 reaches the formatter: the builder throws.',
  },
  {
    id: 'CNC-T-iv. ★★★ the bound holds only its lower half',
    file: NOTIFY,
    find: OFF_CLOCK_IF,
    to: swap(OFF_CLOCK_IF, 'Math.abs(cost.offAtMs) <= MAX_DATE_MS', 'cost.offAtMs >= -MAX_DATE_MS'),
    why: 'An OFF time of 1e300 reaches the formatter: the builder throws.',
  },
  {
    id: 'CNC-T-v. ★★★ the bound leaves out the largest time a Date holds',
    file: NOTIFY,
    find: OFF_CLOCK_IF,
    to: swap(OFF_CLOCK_IF, '<= MAX_DATE_MS', '< MAX_DATE_MS'),
    why: 'A time of exactly ±8.64e15 ms, which the formatter prints, is told with no clock.',
  },
  {
    id: 'CNC-T-vi. ★★★ the bound is one millisecond wide of a Date',
    file: NOTIFY,
    find: MAX_DATE,
    to: "const MAX_DATE_MS = 8.64e15 + 1; /* MUTANT */",
    why: 'A time one millisecond past the range of a Date reaches the formatter: the builder throws.',
  },

  /* ── S: "at its stop" ── */
  {
    id: 'CNC-O-ii. ★★★ any OFF is told as the stop reached',
    file: NOTIFY,
    find: AT_STOP,
    to: "  const atStop = cost.offReason != null; /* MUTANT */",
    why: 'A run-backstop OFF at 2:30am says "reached ~56.7% at 2:30am and was switched off there", and a window-end OFF the same at 5am.',
  },
  {
    id: 'CNC-O-iii. ★★★ the window-end OFF is told as the stop reached',
    file: NOTIFY,
    find: AT_STOP,
    to: "  const atStop = cost.offReason === 'windowEnd'; /* MUTANT */",
    why: 'A force-charge that ran out the window says "reached ~56.7% at 5am", and a target OFF "ran toward ~56.7% and was switched off at 3:12am (it reached its target)".',
  },
  {
    id: 'CNC-S-i. ★★★ "at its stop" needs an OFF time the clock prints',
    file: NOTIFY,
    find: AT_STOP,
    to: "  const atStop = cost.offReason === 'target' && offClock != null; /* MUTANT */",
    why: 'A target OFF with no time on the record says "ran toward ~56.7% and was switched off before the window close (it reached its target)", and an unconfirmed night that read its stop is flagged.',
  },
  {
    id: 'CNC-S-ii. ★★★ a close at or above the stop is told as the stop reached',
    file: NOTIFY,
    find: AT_STOP,
    to: "  const atStop = cost.offReason === 'target' || (poolRead != null && poolRead >= fc.stopPct); /* MUTANT */",
    why: 'A run-backstop OFF on a night that closed at 90% says "reached ~56.7% at 2:30am and was switched off there": the close reading is taken for the OFF\'s own.',
  },
  {
    id: 'CNC-S-iii. ★★★ a night that ran says "reached" only with an OFF time',
    file: NOTIFY,
    find: RAN_STOP,
    to: swap(RAN_STOP, 'atStop ?', 'atStop && offClock != null ?'),
    why: 'A target OFF with no time on the record says "ran toward ~56.7% until the window close".',
  },
  {
    id: 'CNC-S-iv. ★★★ a failed night says the stop was read only with an OFF time',
    file: NOTIFY,
    find: ENDED_STOP,
    to: swap(ENDED_STOP, 'atStop ?', 'atStop && offClock != null ?'),
    why: 'A failed night whose target OFF carries no time says nothing of the stop the pool read.',
  },
  {
    id: 'CNC-S-v. ★★★ a failed night goes under "ON not confirmed" only with an OFF time',
    file: NOTIFY,
    find: FAILED_FLAG_STOP_IF,
    to: swap(FAILED_FLAG_STOP_IF, 'atStop', 'atStop && offClock != null'),
    why: 'A failure on every slot whose target OFF carries no time goes under "closed without its force-charge" beside "the pool read ~56.7% and the force-charge was switched off there".',
  },
  {
    id: 'CNC-S-vi. ★★★ an unconfirmed night reads its stop only with an OFF time',
    file: NOTIFY,
    find: STOP_BRANCH,
    to: "  if (atStop && offClock != null) { /* MUTANT */",
    why: 'An unconfirmed night whose target OFF carries no time says "the panel never confirmed it" under "force-charge not confirmed".',
  },

  /* ── O: what ended a force-charge that ran ── */
  {
    id: 'CNC-O-v. ★★★ "reached" names the unrounded stop',
    file: NOTIFY,
    find: REACHED_WORDS,
    to: swap(REACHED_WORDS, '~${stop}%', '~${fc.stopPct}%'),
    why: '"reached ~56.74% at 3:12am and was switched off there".',
  },
  {
    id: 'CNC-O-vi. ★★★ "reached" names the announced level, not the stop',
    file: NOTIFY,
    find: REACHED_WORDS,
    to: swap(REACHED_WORDS, '~${stop}%', '~${announced ?? stop}%'),
    why: 'On a night whose notice named the 50% reserve, a force-charge that read its ~56.7% stop says "reached ~50% at 3:12am".',
  },
  {
    id: 'CNC-O-vi(b). ★★★ "reached" never names its clock',
    file: NOTIFY,
    find: REACHED_WORDS,
    to: swap(REACHED_WORDS, CLOCK_OPT, ''),
    why: 'A target OFF at 3:12am says "reached ~56.7% and was switched off there": the clock on the record goes unsaid.',
  },
  {
    id: 'CNC-O-vi(c). ★★★ "reached" with no OFF time names a clock',
    file: NOTIFY,
    find: REACHED_WORDS,
    to: swap(REACHED_WORDS, CLOCK_OPT, ' at ${offClock ?? phxShortClock(0)}'),
    why: 'A target OFF with no time on the record says "reached ~56.7% at 5pm", a clock nothing recorded.',
  },
  {
    id: 'CNC-O-vii. ★★★ a verified night never says "reached"',
    file: NOTIFY,
    find: RAN_STOP,
    to: swap(RAN_STOP, 'atStop ?', 'atStop && false ?'),
    why: 'A force-charge switched off at its stop says "ran toward ~56.7% until the window close".',
  },
  {
    id: 'CNC-O-viii. ★★★ no OFF on the record is told as the window close',
    file: NOTIFY,
    find: RAN_NONE,
    to: swap(RAN_NONE, '`ran${w.toward}', '`ran${w.toward} until the window close'),
    why: 'A record with no OFF reason says "ran toward ~56.7% until the window close".',
  },
  {
    id: 'CNC-O-ix. ★★★ the window-end OFF is told as no OFF',
    file: NOTIFY,
    find: RAN_NONE,
    to: swap(RAN_NONE, 'cost.offReason == null ?', "cost.offReason == null || cost.offReason === 'windowEnd' ?"),
    why: 'A force-charge that ran to the window-end OFF says only "ran toward ~56.7%".',
  },
  {
    id: 'CNC-O-ix(b). ★★★ a window-end OFF does not say "until the window close"',
    file: NOTIFY,
    find: RAN_WINDOW,
    to: swap(RAN_WINDOW, ' until the window close', ''),
    why: 'A force-charge that ran to the window-end OFF says only "ran toward ~56.7%".',
  },
  {
    id: 'CNC-O-x. ★★★ the window-end OFF is told as an early one',
    file: NOTIFY,
    find: EARLY_IF,
    to: swap(EARLY_IF, " && cost.offReason !== 'windowEnd'", ''),
    why: '"ran toward ~56.7% and was switched off at 5am (windowEnd)", and a failed night "; it was switched off at 5am (windowEnd)".',
  },
  {
    id: 'CNC-O-xi. ★★★ the window-end test is inverted',
    file: NOTIFY,
    find: RAN_WINDOW,
    to: swap(RAN_WINDOW, 'earlyOff == null ?', 'earlyOff != null ?'),
    why: 'A run-backstop OFF at 2:30am says "ran toward ~56.7% until the window close".',
  },
  {
    id: 'CNC-O-xii. ★★★ an early OFF never names its clock',
    file: NOTIFY,
    find: EARLY_WORDS,
    to: swap(EARLY_WORDS, "${offClock != null ? `at ${offClock}` : 'before the window close'}", 'before the window close'),
    why: 'An OFF at 2:30am says "was switched off before the window close (the run backstop)".',
  },
  {
    id: 'CNC-O-xiii. ★★★ an early OFF with no time names a clock',
    file: NOTIFY,
    find: EARLY_WORDS,
    to: swap(EARLY_WORDS, "${offClock != null ? `at ${offClock}` : 'before the window close'}", 'at ${offClock ?? phxShortClock(0)}'),
    why: 'An OFF with no time on the record says "was switched off at 5pm (the run backstop)", a clock nothing recorded.',
  },
  {
    id: 'CNC-O-xiv. ★★★ an early OFF does not name its cause',
    file: NOTIFY,
    find: EARLY_WORDS,
    to: swap(EARLY_WORDS, ' (${forceChargeOffWords(cost.offReason)})', ''),
    why: '"ran toward ~56.7% and was switched off at 2:30am", with nothing of what switched it off.',
  },
  {
    id: 'CNC-O-xv. ★★★ an early OFF prints the record\'s reason code',
    file: NOTIFY,
    find: EARLY_WORDS,
    to: swap(EARLY_WORDS, '${forceChargeOffWords(cost.offReason)}', '${cost.offReason}'),
    why: '"(maxRun)" in place of "(the run backstop)".',
  },
  {
    id: 'CNC-O-xv(b). ★★★ an early OFF\'s cause keeps the label of the first draft',
    file: NOTIFY,
    find: EARLY_WORDS,
    to: swap(EARLY_WORDS, '(${forceChargeOffWords(cost.offReason)})', '(switched off: ${forceChargeOffWords(cost.offReason)})'),
    why: '"and was switched off at 2:30am (switched off: the run backstop)": the switch-off is said twice.',
  },
  {
    id: 'CNC-O-xvi. ★★★ an early OFF on a night that ran is not said to be a switch-off',
    file: NOTIFY,
    find: RAN_EARLY,
    to: swap(RAN_EARLY, ' and was switched off', ''),
    why: '"ran toward ~56.7% (~6.2 kWh expected) at 2:30am (the run backstop)".',
  },
  {
    id: 'CNC-O-xvii. ★★★ a night with no OFF on its record is told as switched off early',
    file: NOTIFY,
    find: EARLY_IF + NL + EARLY_WORDS,
    to: "  const earlyOff = cost.offReason !== 'windowEnd' && !atStop /* MUTANT */\n    ? ` ${offClock != null ? `at ${offClock}` : 'before the window close'} (${forceChargeOffWords(cost.offReason ?? '')})` : null;",
    why: 'A failed or unconfirmed night with no OFF reason on its record says "; it was switched off before the window close ()".',
  },

  /* ── E: what ended a force-charge that failed or was never confirmed ── */
  {
    id: 'CNC-E-i. ★★★ a failed night at its stop says nothing of the stop',
    file: NOTIFY,
    find: ENDED_STOP,
    to: swap(ENDED_STOP, 'atStop ?', 'atStop && false ?'),
    why: '"closed with its force-charge ON not confirmed" over an account that never says the pool read the stop and the force-charge was switched off there.',
  },
  {
    id: 'CNC-E-ii. ★★★ a failed night\'s stop never names its clock',
    file: NOTIFY,
    find: ENDED_STOP,
    to: swap(ENDED_STOP, CLOCK_OPT, ''),
    why: '"; the pool read ~56.7% and the force-charge was switched off there" for an OFF the record times at 3:12am.',
  },
  {
    id: 'CNC-E-iii. ★★★ a failed night\'s stop with no OFF time names a clock',
    file: NOTIFY,
    find: ENDED_STOP,
    to: swap(ENDED_STOP, CLOCK_OPT, ' at ${offClock ?? phxShortClock(0)}'),
    why: '"; the pool read ~56.7% at 5pm and the force-charge was switched off there", a clock nothing recorded.',
  },
  {
    id: 'CNC-E-iv. ★★★ a failed night\'s stop is not rounded',
    file: NOTIFY,
    find: ENDED_STOP,
    to: swap(ENDED_STOP, '~${stop}%', '~${fc.stopPct}%'),
    why: '"; the pool read ~56.74% at 3:12am" beside "toward ~56.7%".',
  },
  {
    id: 'CNC-E-v. ★★★ a failed night at its stop is told in the words of a force-charge that ran',
    file: NOTIFY,
    find: ENDED_STOP,
    to: "    const ended = atStop ? `; it ${reachedWords}` /* MUTANT */",
    why: '"did not take effect…; it reached ~56.7% at 3:12am and was switched off there": "reached" of an ON no readback showed.',
  },
  {
    id: 'CNC-E-vi. ★★★ a failed night never says what switched its force-charge off early',
    file: NOTIFY,
    find: ENDED_EARLY,
    to: "      : ''; /* MUTANT */",
    why: 'A failed ON the run backstop switched off at 2:30am says nothing of that OFF.',
  },
  {
    id: 'CNC-E-vii. ★★★ a failed night always tells an early OFF',
    file: NOTIFY,
    find: ENDED_EARLY,
    to: "      : `; it was switched off${earlyOff}`; /* MUTANT */",
    why: '"; it was switched offnull" on a failed night that ran to the window end, or with no OFF on its record.',
  },
  {
    id: 'CNC-E-viii. ★★★ a failed night\'s early OFF never names its clock',
    file: NOTIFY,
    find: ENDED_EARLY,
    to: swap(ENDED_EARLY, SWITCHED_OFF, "`; it was switched off before the window close (${forceChargeOffWords(cost.offReason ?? '')})`"),
    why: 'A failed ON switched off at 2:30am says "; it was switched off before the window close (the run backstop)".',
  },
  {
    id: 'CNC-E-ix. ★★★ a failed night\'s early OFF with no time names a clock',
    file: NOTIFY,
    find: ENDED_EARLY,
    to: swap(ENDED_EARLY, SWITCHED_OFF, "`; it was switched off at ${offClock ?? phxShortClock(0)} (${forceChargeOffWords(cost.offReason ?? '')})`"),
    why: '"; it was switched off at 5pm (the run backstop)" for an OFF with no time on the record.',
  },
  {
    id: 'CNC-E-x. ★★★ a failed night\'s early OFF is not said to be a switch-off',
    file: NOTIFY,
    find: ENDED_EARLY,
    to: swap(ENDED_EARLY, SWITCHED_OFF, 'earlyOff'),
    why: '"did not take effect, with no re-issue of the ON at 2:30am (the run backstop)".',
  },
  {
    id: 'CNC-E-xi. ★★★ an unconfirmed night never says what switched its force-charge off early',
    file: NOTIFY,
    find: UNCONF_NIGHT,
    to: swap(UNCONF_NIGHT, EARLY_OPT, ''),
    why: 'An unconfirmed ON the run backstop switched off at 2:30am says nothing of that OFF.',
  },
  {
    id: 'CNC-E-xii. ★★★ an unconfirmed night always tells an early OFF',
    file: NOTIFY,
    find: UNCONF_NIGHT,
    to: swap(UNCONF_NIGHT, EARLY_OPT, '; it was switched off${earlyOff}'),
    why: '"the panel never confirmed it; it was switched offnull" on a night that ran to the window end.',
  },
  {
    id: 'CNC-E-xiii. ★★★ an unconfirmed night\'s early OFF never names its clock',
    file: NOTIFY,
    find: UNCONF_NIGHT,
    to: swap(UNCONF_NIGHT, SWITCHED_OFF, "`; it was switched off before the window close (${forceChargeOffWords(cost.offReason ?? '')})`"),
    why: 'An unconfirmed ON switched off at 2:30am says "; it was switched off before the window close (the run backstop)".',
  },
  {
    id: 'CNC-E-xiv. ★★★ an unconfirmed night\'s early OFF with no time names a clock',
    file: NOTIFY,
    find: UNCONF_NIGHT,
    to: swap(UNCONF_NIGHT, SWITCHED_OFF, "`; it was switched off at ${offClock ?? phxShortClock(0)} (${forceChargeOffWords(cost.offReason ?? '')})`"),
    why: '"; it was switched off at 5pm (the run backstop)" for an OFF with no time on the record.',
  },
  {
    id: 'CNC-E-xv. ★★★ an unconfirmed night\'s early OFF is not said to be a switch-off',
    file: NOTIFY,
    find: UNCONF_NIGHT,
    to: swap(UNCONF_NIGHT, SWITCHED_OFF, 'earlyOff'),
    why: '"the panel never confirmed it at 2:30am (the run backstop)".',
  },
  {
    id: 'CNC-E-xvi. ★★★ an unconfirmed night names the slots left out ahead of the early OFF',
    file: NOTIFY,
    find: UNCONF_NIGHT,
    to: swap(UNCONF_NIGHT, EARLY_OPT + '${leftOutWords}', '${leftOutWords}' + EARLY_OPT),
    why: '"; slot(s) 1 not switched on (…); it was switched off at 2:30am (the run backstop)": "it" reads as the slot.',
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
    to: "  const reissues = reissuesKnown && cost.onReissues > 1 ? cost.onReissues : 0; /* MUTANT */",
    why: 'One re-issue (the most the add-on makes) is told as "with no re-issue of the ON".',
  },
  {
    id: 'CNC-R-ii(b). ★★★ an unusable count is told as one re-issue',
    file: NOTIFY,
    find: REISSUES,
    to: swap(REISSUES, 'cost.onReissues : 0', 'cost.onReissues : 1'),
    why: 'A count of NaN or -1 on a damaged record says ", after one re-issue of the ON" on a night that ran or was never confirmed: a re-issue the record does not hold.',
  },
  {
    id: 'CNC-R-iii. ★★★ a count that is no whole number is taken',
    file: NOTIFY,
    find: REISSUES_KNOWN,
    to: swap(REISSUES_KNOWN, 'Number.isInteger(cost.onReissues) && ', ''),
    why: '", after 1.5 re-issues of the ON", ", after Infinity re-issues of the ON".',
  },
  {
    id: 'CNC-R-iii(b). ★★★ a negative count is taken',
    file: NOTIFY,
    find: REISSUES_KNOWN,
    to: swap(REISSUES_KNOWN, ' && cost.onReissues >= 0', ''),
    why: 'A count of -1 on a damaged record says "with no re-issue of the ON" on a failed night: a fact the record does not hold.',
  },
  {
    id: 'CNC-R-iii(c). ★★★ a count of zero is no count',
    file: NOTIFY,
    find: REISSUES_KNOWN,
    to: swap(REISSUES_KNOWN, 'cost.onReissues >= 0', 'cost.onReissues > 0'),
    why: 'A failed ON that was never re-issued says nothing of it: "with no re-issue of the ON" is gone from the 2026-11-16 night.',
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
    id: 'CNC-R-vi(a). ★★★ a force-charge that reached its stop never says its ON was re-issued',
    file: NOTIFY,
    find: RAN_STOP,
    to: swap(RAN_STOP, '${afterReissue}', ''),
    why: '"reached ~56.7% at 3:12am and was switched off there (~6.2 kWh expected)" on a night whose ON took a re-issue.',
  },
  {
    id: 'CNC-R-vi(b). ★★★ a force-charge with no OFF on its record never says its ON was re-issued',
    file: NOTIFY,
    find: RAN_NONE,
    to: swap(RAN_NONE, '${afterReissue}', ''),
    why: '"ran toward ~56.7% (~6.2 kWh expected)" on a night whose ON took a re-issue.',
  },
  {
    id: 'CNC-R-vi(c). ★★★ a force-charge that ran to the window end never says its ON was re-issued',
    file: NOTIFY,
    find: RAN_WINDOW,
    to: swap(RAN_WINDOW, '${afterReissue}', ''),
    why: '"ran toward ~56.7% until the window close (~6.2 kWh expected)" on a night whose ON took two re-issues.',
  },
  {
    id: 'CNC-R-vi(d). ★★★ a force-charge switched off early never says its ON was re-issued',
    file: NOTIFY,
    find: RAN_EARLY,
    to: swap(RAN_EARLY, '${afterReissue}', ''),
    why: '"and was switched off at 2:30am (the run backstop)" on a night whose ON took a re-issue.',
  },
  {
    id: 'CNC-R-vii. ★★★ a verified or unconfirmed night always names a re-issue count',
    file: NOTIFY,
    find: AFTER_REISSUE,
    to: "  const afterReissue = `, after ${reissueWords}`; /* MUTANT */",
    why: '", after 0 re-issues of the ON" on every night whose ON took at once.',
  },
  {
    id: 'CNC-R-vii(b). ★★★ the re-issue is said in a bracket',
    file: NOTIFY,
    find: AFTER_REISSUE,
    to: swap(AFTER_REISSUE, '`, after ${reissueWords}`', '` (after ${reissueWords})`'),
    why: '"and was switched off at 2:30am (the run backstop) (after one re-issue of the ON)": two brackets in a row.',
  },
  {
    id: 'CNC-R-vii(c). ★★★ one re-issue goes unsaid on a verified or unconfirmed night',
    file: NOTIFY,
    find: AFTER_REISSUE,
    to: swap(AFTER_REISSUE, 'reissues > 0', 'reissues > 1'),
    why: 'One re-issue (the most the add-on makes) is not said on a night whose force-charge ran or was never confirmed.',
  },
  {
    id: 'CNC-R-viii. ★★★ a failed night always says "with no re-issue"',
    file: NOTIFY,
    find: REISSUE_FACT,
    to: swap(REISSUE_FACT, "reissues > 0 ? `, after ${reissueWords}` : ', with no re-issue of the ON'", "', with no re-issue of the ON'"),
    why: 'An ON that was re-issued once and still did not take effect says "with no re-issue of the ON".',
  },
  {
    id: 'CNC-R-ix. ★★★ a failed night always says "after N re-issues"',
    file: NOTIFY,
    find: REISSUE_FACT,
    to: swap(REISSUE_FACT, "reissues > 0 ? `, after ${reissueWords}` : ', with no re-issue of the ON'", '`, after ${reissueWords}`'),
    why: 'The 2026-11-16 night says "after 0 re-issues of the ON".',
  },
  {
    id: 'CNC-R-x. ★★★ a failed night says nothing of the re-issue',
    file: NOTIFY,
    find: REISSUE_FACT,
    to: "    const reissueFact = ''; /* MUTANT */",
    why: '"was switched ON but did not take effect on slot(s) 2, 3 (…); the pool read 49% at the close": whether the ON was sent again goes unsaid.',
  },
  {
    id: 'CNC-R-x(b). ★★★ a failed night does not say that no re-issue was made',
    file: NOTIFY,
    find: REISSUE_FACT,
    to: swap(REISSUE_FACT, "', with no re-issue of the ON'", "''"),
    why: 'The 2026-11-16 night no longer says "with no re-issue of the ON": a failed ON reads the same whether or not it was sent again.',
  },
  {
    id: 'CNC-R-x(c). ★★★ a failed night does not say that a re-issue was made',
    file: NOTIFY,
    find: REISSUE_FACT,
    to: swap(REISSUE_FACT, '`, after ${reissueWords}`', "''"),
    why: 'An ON that was re-issued and still did not take effect says nothing of the re-issue.',
  },
  {
    id: 'CNC-R-x(d). ★★★ one re-issue on a failed night is told as none',
    file: NOTIFY,
    find: REISSUE_FACT,
    to: swap(REISSUE_FACT, 'reissues > 0', 'reissues > 1'),
    why: 'An ON re-issued once says "with no re-issue of the ON".',
  },
  {
    id: 'CNC-R-x(e). ★★★ an unusable count on a failed night is told as no re-issue',
    file: NOTIFY,
    find: REISSUE_FACT,
    to: swap(REISSUE_FACT, "!reissuesKnown ? '' : ", ''),
    why: 'A count of NaN, -1 or 1.5 on a damaged record says "with no re-issue of the ON": a fact the record does not hold.',
  },
  {
    id: 'CNC-R-x(f). ★★★ the usable-count test of a failed night is inverted',
    file: NOTIFY,
    find: REISSUE_FACT,
    to: swap(REISSUE_FACT, '!reissuesKnown', 'reissuesKnown'),
    why: 'A usable count says nothing, and an unusable one says "with no re-issue of the ON".',
  },
  {
    id: 'CNC-R-x(g). ★★★ a failed night says its re-issue in a bracket',
    file: NOTIFY,
    find: REISSUE_FACT,
    to: "    const reissueFact = !reissuesKnown ? '' : reissues > 0 ? ` (after ${reissueWords})` : ' (with no re-issue of the ON)'; /* MUTANT */",
    why: '"(the buy above the reserve did not happen on those slot(s)) (with no re-issue of the ON)": two brackets in a row.',
  },
  {
    id: 'CNC-R-xi. ★★★ an unconfirmed night never says its ON was re-issued',
    file: NOTIFY,
    find: UNCONF_NIGHT,
    to: swap(UNCONF_NIGHT, '${afterReissue}', ''),
    why: '"was switched ON but the panel never confirmed it; the pool read 52% at the close" on a night whose ON took a re-issue.',
  },
  {
    id: 'CNC-R-xi(b). ★★★ an unconfirmed night at its stop never says its ON was re-issued',
    file: NOTIFY,
    find: UNCONF_REACHED_NIGHT,
    to: swap(UNCONF_REACHED_NIGHT, '${afterReissue}', ''),
    why: '"with no readback showing every slot ON; the pool read 57% at the close" on a night whose ON took a re-issue.',
  },
  {
    id: 'CNC-R-xii. ★★★ an unconfirmed night always names a re-issue count',
    file: NOTIFY,
    find: UNCONF_NIGHT,
    to: swap(UNCONF_NIGHT, '${afterReissue}', ', after ${reissueWords}'),
    why: '"the panel never confirmed it, after 0 re-issues of the ON".',
  },
  {
    id: 'CNC-R-xii(b). ★★★ an unconfirmed night at its stop always names a re-issue count',
    file: NOTIFY,
    find: UNCONF_REACHED_NIGHT,
    to: swap(UNCONF_REACHED_NIGHT, '${afterReissue}', ', after ${reissueWords}'),
    why: '"with no readback showing every slot ON, after 0 re-issues of the ON".',
  },
  {
    id: 'CNC-R-xiii(a). ★★★ beside an early OFF the re-issue is set ahead of the figure and the OFF',
    file: NOTIFY,
    find: RAN_EARLY,
    to: "          : `ran${w.toward}${afterReissue}${w.note} and was switched off${earlyOff}`; /* MUTANT */",
    why: '"ran toward ~56.7%, after one re-issue of the ON (~6.2 kWh expected) and was switched off at 2:30am (the run backstop)".',
  },
  {
    id: 'CNC-R-xiii(b). ★★★ an unconfirmed night at its stop says the re-issue ahead of the missing readback',
    file: NOTIFY,
    find: UNCONF_REACHED_NIGHT,
    to: swap(UNCONF_REACHED_NIGHT, ', with no readback showing every slot ON${afterReissue}', '${afterReissue}, with no readback showing every slot ON'),
    why: '"and was switched off there, after one re-issue of the ON, with no readback showing every slot ON".',
  },
  {
    id: 'CNC-R-xiii(c). ★★★ a failed night says the re-issue after what ended its force-charge',
    file: NOTIFY,
    find: FAILED_NIGHT,
    to: swap(FAILED_NIGHT, '${reissueFact}${ended}', '${ended}${reissueFact}'),
    why: '"; the pool read ~56.7% at 3:12am and the force-charge was switched off there, after one re-issue of the ON": the re-issue reads as the OFF\'s.',
  },
  {
    id: 'CNC-R-xiii(d). ★★★ an unconfirmed night says the re-issue after its early OFF',
    file: NOTIFY,
    find: UNCONF_NIGHT,
    to: swap(UNCONF_NIGHT, '${afterReissue}' + EARLY_OPT, EARLY_OPT + '${afterReissue}'),
    why: '"; it was switched off at 2:30am (the run backstop), after one re-issue of the ON": the re-issue reads as the OFF\'s.',
  },

  /* ── N: a start that never came and was not needed ── */
  {
    id: 'CNC-N-i. ★★★ a close with no reading leaves a start that never came unflagged',
    file: NOTIFY,
    find: NOT_NEEDED,
    to: "    const notNeeded = cost.readLate !== true && (poolRead == null || poolRead >= fc.stopPct); /* MUTANT */",
    why: '"completed", under "reserve restored to 16%", on an announced force-charge that never started and a pool nobody read.',
  },
  {
    id: 'CNC-N-ii. ★★★ a late reading at or above the stop leaves the night unflagged',
    file: NOTIFY,
    find: NOT_NEEDED,
    to: swap(NOT_NEEDED, ' && cost.readLate !== true', ''),
    why: 'A reading taken hours after the close, with the sun up, clears a force-charge that never started.',
  },
  {
    id: 'CNC-N-iii. ★★★ the late test of "not needed" is inverted',
    file: NOTIFY,
    find: NOT_NEEDED,
    to: swap(NOT_NEEDED, 'cost.readLate !== true', 'cost.readLate === true'),
    why: 'A pool read at 57% at the close is flagged "force-charge did not run"; one read late is not.',
  },
  {
    id: 'CNC-N-iv. ★★★ any reading in time leaves the night unflagged',
    file: NOTIFY,
    find: NOT_NEEDED,
    to: swap(NOT_NEEDED, ' && poolRead >= fc.stopPct', ''),
    why: 'An announced force-charge that never started, with the pool at 49% against a 56.7% stop, goes under "completed".',
  },
  {
    id: 'CNC-N-v. ★★★ a reading equal to the stop is under it',
    file: NOTIFY,
    find: NOT_NEEDED,
    to: swap(NOT_NEEDED, 'poolRead >= fc.stopPct', 'poolRead > fc.stopPct'),
    why: 'A pool read at exactly its 56.7% stop is flagged "force-charge did not run": decideForceCharge declines a start there.',
  },
  {
    id: 'CNC-N-vi. ★★★ the comparison of "not needed" is inverted',
    file: NOTIFY,
    find: NOT_NEEDED,
    to: swap(NOT_NEEDED, 'poolRead >= fc.stopPct', 'poolRead < fc.stopPct'),
    why: 'A pool under its stop goes under "completed"; one at or above it is flagged.',
  },
  {
    id: 'CNC-N-vii. ★★★ "not needed" compares the rounded reading with the rounded stop',
    file: NOTIFY,
    find: NOT_NEEDED,
    to: "    const notNeeded = read != null && cost.readLate !== true && read >= stop; /* MUTANT */",
    why: 'A 56.69% reading against a 56.7% stop prints 56.7% and is taken as at the stop: the start that never came goes unflagged.',
  },
  {
    id: 'CNC-N-viii. ★★★ "not needed" compares the reading with the rounded stop',
    file: NOTIFY,
    find: NOT_NEEDED,
    to: swap(NOT_NEEDED, 'poolRead >= fc.stopPct', 'poolRead >= stop'),
    why: 'A 56.7% reading against a 56.74% stop (it prints ~56.7%) is taken as at the stop.',
  },
  {
    id: 'CNC-N-ix. ★★★ "not needed" compares the rounded reading with the stop',
    file: NOTIFY,
    find: NOT_NEEDED,
    to: "    const notNeeded = read != null && cost.readLate !== true && read >= fc.stopPct; /* MUTANT */",
    why: 'A 56.652% reading against a 56.66% stop rounds up past it and goes unflagged; a 56.74% reading against a 56.74% stop rounds under it and is flagged.',
  },
  {
    id: 'CNC-N-x. ★★★ a start that never came is flagged whatever the pool reads',
    file: NOTIFY,
    find: NEVER_FLAG,
    to: swap(NEVER_FLAG, 'notNeeded ? null : ', ''),
    why: 'A night whose pool stood at or above its stop (no start was due) goes under "closed without its force-charge" and "force-charge did not run".',
  },
  {
    id: 'CNC-N-xi. ★★★ the flag of a start that never came is inverted',
    file: NOTIFY,
    find: NEVER_FLAG,
    to: swap(NEVER_FLAG, 'notNeeded ? null', '!notNeeded ? null'),
    why: 'Flagged where no start was due; "completed" where the pool closed under its stop.',
  },

  /* ── K: each shape's own words, and the place of the expected figure ── */
  {
    id: 'CNC-K-i. ★★★ a night whose force-charge ran states no close',
    file: NOTIFY,
    find: RAN_NIGHT,
    to: swap(RAN_NIGHT, '${close}', ''),
    why: '"force-charge ran toward ~56.7% until the window close (~6.2 kWh expected); the reserve is restored": where the pool closed goes unsaid.',
  },
  {
    id: 'CNC-K-ii(a). ★★★ the expected figure is gone beside a force-charge that reached its stop',
    file: NOTIFY,
    find: RAN_STOP,
    to: swap(RAN_STOP, '${w.note}', ''),
    why: '"(~6.2 kWh expected)" is dropped from "reached ~56.7% at 3:12am and was switched off there".',
  },
  {
    id: 'CNC-K-ii(b). ★★★ the expected figure is gone beside a force-charge with no OFF on its record',
    file: NOTIFY,
    find: RAN_NONE,
    to: swap(RAN_NONE, '${w.note}', ''),
    why: '"(~6.2 kWh expected)" is dropped from "ran toward ~56.7%".',
  },
  {
    id: 'CNC-K-ii(c). ★★★ the expected figure is gone beside a force-charge that ran to the window end',
    file: NOTIFY,
    find: RAN_WINDOW,
    to: swap(RAN_WINDOW, '${w.note}', ''),
    why: '"(~6.2 kWh expected)" is dropped from "ran toward ~56.7% until the window close".',
  },
  {
    id: 'CNC-K-ii(d). ★★★ the expected figure is gone beside a force-charge switched off early',
    file: NOTIFY,
    find: RAN_EARLY,
    to: swap(RAN_EARLY, '${w.note}', ''),
    why: '"(~6.2 kWh expected)" is dropped from "ran toward ~56.7% and was switched off at 2:30am (the run backstop)".',
  },
  {
    id: 'CNC-K-iii(a). ★★★ at its stop the expected figure is set ahead of the re-issue',
    file: NOTIFY,
    find: RAN_STOP,
    to: swap(RAN_STOP, '${afterReissue}${w.note}', '${w.note}${afterReissue}'),
    why: '"and was switched off there (~6.2 kWh expected), after one re-issue of the ON": the figure splits the charge\'s own phrase.',
  },
  {
    id: 'CNC-K-iii(b). ★★★ with no OFF the expected figure is set ahead of the re-issue',
    file: NOTIFY,
    find: RAN_NONE,
    to: swap(RAN_NONE, '${afterReissue}${w.note}', '${w.note}${afterReissue}'),
    why: '"ran toward ~56.7% (~6.2 kWh expected), after one re-issue of the ON".',
  },
  {
    id: 'CNC-K-iii(c). ★★★ at the window end the expected figure is set ahead of the re-issue',
    file: NOTIFY,
    find: RAN_WINDOW,
    to: swap(RAN_WINDOW, '${afterReissue}${w.note}', '${w.note}${afterReissue}'),
    why: '"until the window close (~6.2 kWh expected), after 2 re-issues of the ON".',
  },
  {
    id: 'CNC-K-iii(d). ★★★ at the window end the expected figure is set ahead of "until the window close"',
    file: NOTIFY,
    find: RAN_WINDOW,
    to: "        : earlyOff == null ? `ran${w.toward}${w.note} until the window close${afterReissue}` /* MUTANT */",
    why: '"ran toward ~56.7% (~6.2 kWh expected) until the window close".',
  },
  {
    id: 'CNC-K-iii(e). ★★★ beside an early OFF the expected figure follows the OFF\'s cause',
    file: NOTIFY,
    find: RAN_EARLY,
    to: "          : `ran${w.toward} and was switched off${earlyOff}${w.note}${afterReissue}`; /* MUTANT */",
    why: '"and was switched off at 2:30am (the run backstop) (~6.2 kWh expected)": two brackets in a row, and the figure reads as the OFF\'s.',
  },
  {
    id: 'CNC-K-iii(f). ★★★ beside an early OFF the expected figure follows the re-issue',
    file: NOTIFY,
    find: RAN_EARLY,
    to: "          : `ran${w.toward} and was switched off${earlyOff}${afterReissue}${w.note}`; /* MUTANT */",
    why: '"(the run backstop), after one re-issue of the ON (~6.2 kWh expected)", and two brackets in a row where no re-issue was made.',
  },
  {
    id: 'CNC-K-iii(g). ★★★ the expected figure is set after the close clause on every form',
    file: NOTIFY,
    find: RAN_STOP + NL + RAN_NONE + NL + RAN_WINDOW + NL + RAN_EARLY + NL + RETURN_OPEN + NL + RAN_NIGHT,
    to: "    const ran = atStop ? `${reachedWords}${afterReissue}` /* MUTANT */\n"
      + "      : cost.offReason == null ? `ran${w.toward}${afterReissue}`\n"
      + "        : earlyOff == null ? `ran${w.toward} until the window close${afterReissue}`\n"
      + "          : `ran${w.toward} and was switched off${earlyOff}${afterReissue}`;\n"
      + "    return {\n"
      + "      night: `${w.reserve}, and force-charge ${ran}${leftOutWords}${close}${w.note}; ${w.restored}`,",
    why: '"the pool was not read at the close (no fresh panel reading) (~6.2 kWh expected)": two brackets in a row, and the figure reads as the reading\'s.',
  },
  {
    id: 'CNC-K-iv. ★★★ a start that never came states no close',
    file: NOTIFY,
    find: NEVER_NIGHT,
    to: "      night: `${w.reserve}${w.note}; force-charge${w.toward} never started${w.gridLost ? ' (the grid read as lost)' : ''}; ${w.restored}`, /* MUTANT */",
    why: '"closed without its force-charge: … never started; the reserve is restored": the 49% the pool closed at goes unsaid.',
  },
  {
    id: 'CNC-K-v. ★★★ the never-started account drops the grid loss',
    file: NOTIFY,
    find: NEVER_NIGHT,
    to: "      night: `${w.reserve}${w.note}; force-charge${w.toward} never started${close}; ${w.restored}`, /* MUTANT */",
    why: '"never started; the pool read 49%…" on a night the grid read as lost: why it never started goes unsaid.',
  },
  {
    id: 'CNC-K-vi. ★★★ every never-started account blames the grid',
    file: NOTIFY,
    find: NEVER_NIGHT,
    to: "      night: `${w.reserve}${w.note}; force-charge${w.toward} never started (the grid read as lost)${close}; ${w.restored}`, /* MUTANT */",
    why: '"never started (the grid read as lost)" on a night whose grid never read lost.',
  },
  {
    id: 'CNC-K-vii. ★★★ the never-started account does not name its stop',
    file: NOTIFY,
    find: NEVER_NIGHT,
    to: "      night: `${w.reserve}${w.note}; force-charge never started${w.gridLost ? ' (the grid read as lost)' : ''}${close}; ${w.restored}`, /* MUTANT */",
    why: '"force-charge never started" with no "toward ~56.7%".',
  },
  {
    id: 'CNC-K-viii. ★★★ a failed night states no close',
    file: NOTIFY,
    find: FAILED_NIGHT,
    to: swap(FAILED_NIGHT, '${close}', ''),
    why: 'The 2026-11-16 night is flagged and still does not say it closed at 49% against the ~56.7% announced.',
  },
  {
    id: 'CNC-K-ix. ★★★ a failed night does not name its stop',
    file: NOTIFY,
    find: FAILED_NIGHT,
    to: swap(FAILED_NIGHT, 'force-charge${w.toward} ', 'force-charge '),
    why: '"force-charge was switched ON but did not take effect" with no "toward ~56.7%".',
  },
  {
    id: 'CNC-K-x. ★★★ an unconfirmed night at its stop states no close',
    file: NOTIFY,
    find: UNCONF_REACHED_NIGHT,
    to: swap(UNCONF_REACHED_NIGHT, '${close}', ''),
    why: '"reached ~56.7% at 12:20am and was switched off there, with no readback showing every slot ON; the reserve is restored".',
  },
  {
    id: 'CNC-K-xi. ★★★ an ON never read back on every slot reads as a verified one',
    file: NOTIFY,
    find: UNCONF_REACHED_NIGHT,
    to: swap(UNCONF_REACHED_NIGHT, ', with no readback showing every slot ON', ''),
    why: '"force-charge reached ~56.7% at 12:20am and was switched off there; the pool read 57%…" with nothing of the missing readback.',
  },
  {
    id: 'CNC-K-xii. ★★★ an unconfirmed night states no close',
    file: NOTIFY,
    find: UNCONF_NIGHT,
    to: swap(UNCONF_NIGHT, '${close}', ''),
    why: '"closed with its force-charge unconfirmed: … the panel never confirmed it; the reserve is restored".',
  },
  {
    id: 'CNC-K-xiii. ★★★ an unconfirmed night does not name its stop',
    file: NOTIFY,
    find: UNCONF_NIGHT,
    to: swap(UNCONF_NIGHT, 'force-charge${w.toward} ', 'force-charge '),
    why: '"force-charge was switched ON but the panel never confirmed it" with no "toward ~56.7%".',
  },
  {
    id: 'CNC-K-xiv. ★★★ a failure on some slots is told in the whole-failure words',
    file: NOTIFY,
    find: FAILED_WORDS_SOME,
    to: "      ? 'was switched ON but did not take effect' /* MUTANT */",
    why: 'The body of a failure on slots 2 and 3 says "was switched ON but did not take effect", with no slot named.',
  },
  {
    id: 'CNC-K-xv. ★★★ the body of a failure on some slots names its first slot only',
    file: NOTIFY,
    find: FAILED_WORDS_SOME,
    to: swap(FAILED_WORDS_SOME, "fc.partialSlots!.join(', ')", 'fc.partialSlots![0]'),
    why: '"did not take effect on slot(s) 2" on a failure of slots 2 and 3.',
  },
  {
    id: 'CNC-K-xvi. ★★★ the body of a failure on some slots drops what did not happen there',
    file: NOTIFY,
    find: FAILED_WORDS_SOME,
    to: swap(FAILED_WORDS_SOME, ' (the buy above the reserve did not happen on those slot(s))', ''),
    why: '"did not take effect on slot(s) 2, 3, with no re-issue of the ON": the buy that did not happen goes unsaid.',
  },
  {
    id: 'CNC-K-xvii. ★★★ a failure on every slot loses its words',
    file: NOTIFY,
    find: FAILED_WORDS_SOME + NL + FAILED_WORDS_ALL,
    to: FAILED_WORDS_SOME + NL + "      : ''; /* MUTANT */",
    why: '"force-charge toward ~56.7% , with no re-issue of the ON": the failure itself goes unsaid.',
  },
  {
    id: 'CNC-K-xviii. ★★★ a failure on every slot, switched off at its stop, is told as a charge that did not happen',
    file: NOTIFY,
    find: FAILED_WORDS_STOP,
    to: '    const failedWords = partial /* MUTANT */',
    why: 'Under the lead "ON not confirmed" the body says "was switched ON but did not take effect" and then that the pool read its stop: the body states as fact what the lead declines to state.',
  },
  {
    id: 'CNC-K-xix. ★★★ a failure on some slots, switched off at its stop, loses its slots to the failed-check words',
    file: NOTIFY,
    find: FAILED_WORDS_STOP,
    to: swap(FAILED_WORDS_STOP, '!partial && atStop', 'atStop'),
    why: 'A failure on slots 2 and 3 that was switched off at its stop reads "its readback check failed", with no slot named and the buy that did not happen there unsaid.',
  },
  {
    id: 'CNC-K-xx. ★★★ a failure on every slot away from its stop is told as a failed check only',
    file: NOTIFY,
    find: FAILED_WORDS_STOP,
    to: swap(FAILED_WORDS_STOP, '!partial && atStop', '!partial'),
    why: 'A force-charge that took on no slot and never reached its stop reads "its readback check failed": that it did not take effect goes unsaid.',
  },

  /* ── P: the failed-slot list ── */
  {
    id: 'CNC-P-i. ★★★ an empty failed-slot list is read as a failure on some slots',
    file: NOTIFY,
    find: PARTIAL,
    to: swap(PARTIAL, ' && fc.partialSlots.length > 0', ''),
    why: '"did not take effect on slot(s)  (the buy above the reserve did not happen on those slot(s))" under the title "force-charge not applied on slot(s) ".',
  },
  {
    id: 'CNC-P-ii. ★★★ a failure on one slot is read as one on every slot',
    file: NOTIFY,
    find: PARTIAL,
    to: swap(PARTIAL, 'length > 0', 'length > 1'),
    why: 'A failure on slot 2 alone goes under "closed without its force-charge" and "force-charge did not take effect", with no slot named.',
  },
  {
    id: 'CNC-P-iii. ★★★ a null failed-slot list is read as a list',
    file: NOTIFY,
    find: PARTIAL,
    to: "    const partial = fc.partialSlots!.length > 0; /* MUTANT */",
    why: 'The builder throws on every failure with no slot list (the record of a whole failure): the summary is never sent.',
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
    to: swap(NEVER_FLAG, "{ lead: 'closed without its force-charge', title: 'force-charge did not run' }", 'null'),
    why: '"completed", under "reserve restored to 16%", on a night whose announced force-charge never started.',
  },
  {
    id: 'CNC-F-iii. ★★★ the never-started lead reads "completed"',
    file: NOTIFY,
    find: NEVER_FLAG,
    to: swap(NEVER_FLAG, "lead: 'closed without its force-charge'", "lead: 'completed'"),
    why: 'The title says "force-charge did not run" and the body opens "Supervised night charge for … completed".',
  },
  {
    id: 'CNC-F-iv. ★★★ the never-started title is the failed night\'s',
    file: NOTIFY,
    find: NEVER_FLAG,
    to: swap(NEVER_FLAG, "title: 'force-charge did not run'", "title: 'force-charge did not take effect'"),
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
    to: "          : null, /* MUTANT */",
    why: '"completed", under "reserve restored to 16%", on a night whose force-charge took effect on no slot.',
  },
  {
    id: 'CNC-F-v(c). ★★★ an ON that did not take effect on any slot, switched off at its stop, is not flagged',
    file: NOTIFY,
    find: FAILED_FLAG_STOP,
    to: "          ? null /* MUTANT */",
    why: '"completed", under "reserve restored to 16%", over "was switched ON but did not take effect".',
  },
  {
    id: 'CNC-F-vi. ★★★ a failure on some slots is told as one on every slot',
    file: NOTIFY,
    find: FAILED_FLAG_IF,
    to: swap(FAILED_FLAG_IF, 'partial', 'partial && reissues < 0'),
    why: 'A failure on slots 2 and 3 goes under "closed without its force-charge" and "force-charge did not take effect".',
  },
  {
    id: 'CNC-F-vi(b). ★★★ a failure on some slots, switched off at its stop, loses its slots',
    file: NOTIFY,
    find: FAILED_FLAG_IF,
    to: swap(FAILED_FLAG_IF, 'partial', 'partial && !atStop'),
    why: 'A failure on slots 2 and 3 whose OFF read the stop goes under "ON not confirmed", with no slot in the lead or the title.',
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
    to: swap(FAILED_FLAG_SOME, "lead: 'closed with its force-charge not applied on every slot'", "lead: 'closed without its force-charge'"),
    why: 'A night one slot charged on opens "closed without its force-charge".',
  },
  {
    id: 'CNC-F-ix. ★★★ the partial failure\'s title names no slot',
    file: NOTIFY,
    find: FAILED_FLAG_SOME,
    to: swap(FAILED_FLAG_SOME, "title: `force-charge not applied on slot(s) ${fc.partialSlots!.join(', ')}`", "title: 'force-charge did not take effect'"),
    why: '"force-charge did not take effect — reserve restored to 16%" on a failure of slots 2 and 3 only.',
  },
  {
    id: 'CNC-F-x. ★★★ the partial failure\'s title names its first slot only',
    file: NOTIFY,
    find: FAILED_FLAG_SOME,
    to: swap(FAILED_FLAG_SOME, "fc.partialSlots!.join(', ')", 'fc.partialSlots![0]'),
    why: '"force-charge not applied on slot(s) 2" on a failure of slots 2 and 3.',
  },
  {
    id: 'CNC-F-xi. ★★★ the whole failure\'s lead is the partial one\'s',
    file: NOTIFY,
    find: FAILED_FLAG_ALL,
    to: swap(FAILED_FLAG_ALL, "lead: 'closed without its force-charge'", "lead: 'closed with its force-charge not applied on every slot'"),
    why: 'A failure on every slot opens "not applied on every slot".',
  },
  {
    id: 'CNC-F-xii. ★★★ the whole failure\'s title is the never-started night\'s',
    file: NOTIFY,
    find: FAILED_FLAG_ALL,
    to: swap(FAILED_FLAG_ALL, "title: 'force-charge did not take effect'", "title: 'force-charge did not run'"),
    why: 'An ON that was written, and did not take effect, is titled "force-charge did not run".',
  },
  {
    id: 'CNC-F-xiii. ★★★ an unconfirmed night ignores a stop that was read',
    file: NOTIFY,
    find: STOP_BRANCH,
    to: "  if (atStop && false) { /* MUTANT */",
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
    to: "  if (fc.kind === 'neverStarted' && reissues < 0) { /* MUTANT */",
    why: '"was switched ON but the panel never confirmed it", under "force-charge not confirmed", on a night nothing was switched ON.',
  },
  {
    id: 'CNC-F-xx. ★★★ a failed ON is told as an unconfirmed one',
    file: NOTIFY,
    find: KIND_FAILED,
    to: "  if (fc.kind === 'failed' && reissues < 0) { /* MUTANT */",
    why: '"the panel never confirmed it", under "force-charge not confirmed", on an ON the readback showed not applied.',
  },
  {
    id: 'CNC-F-xxi. ★★★ a failure on every slot, switched off at its stop, is told as one that never charged',
    file: NOTIFY,
    find: FAILED_FLAG_STOP,
    to: "          ? { lead: 'closed without its force-charge', title: 'force-charge did not take effect' } /* MUTANT */",
    why: '"closed without its force-charge" over "the pool read ~56.7% at 3:12am and the force-charge was switched off there": a pool that reached its stop was charged.',
  },
  {
    id: 'CNC-F-xxii. ★★★ the at-its-stop lead claims no force-charge',
    file: NOTIFY,
    find: FAILED_FLAG_STOP,
    to: swap(FAILED_FLAG_STOP, "lead: 'closed with its force-charge ON not confirmed'", "lead: 'closed without its force-charge'"),
    why: 'The title says "force-charge ON not confirmed" and the body opens "closed without its force-charge".',
  },
  {
    id: 'CNC-F-xxiii. ★★★ the at-its-stop title is the unconfirmed night\'s',
    file: NOTIFY,
    find: FAILED_FLAG_STOP,
    to: swap(FAILED_FLAG_STOP, "title: 'force-charge ON not confirmed'", "title: 'force-charge not confirmed'"),
    why: 'An ON the readback showed not applied is titled as one nothing read back.',
  },
  {
    id: 'CNC-F-xxiv. ★★★ the at-its-stop test of the failed flag is inverted',
    file: NOTIFY,
    find: FAILED_FLAG_STOP_IF,
    to: swap(FAILED_FLAG_STOP_IF, 'atStop', '!atStop'),
    why: 'The 2026-11-16 shape on every slot goes under "ON not confirmed"; a failure whose OFF read the stop goes under "closed without its force-charge".',
  },
  {
    id: 'CNC-F-xxv. ★★★ a failed ON switched off early is not flagged',
    file: NOTIFY,
    find: FAILED_FLAG_ALL,
    to: swap(FAILED_FLAG_ALL, ': {', ': earlyOff != null ? null : {'),
    why: '"completed", under "reserve restored to 16%", on an ON that took effect on no slot and was switched off by the run backstop.',
  },
  {
    id: 'CNC-F-xxvi. ★★★ a failed ON is not flagged where the pool closed at or above its stop',
    file: NOTIFY,
    find: FAILED_FLAG_ALL,
    to: swap(FAILED_FLAG_ALL, ': {', ': poolRead != null && poolRead >= fc.stopPct ? null : {'),
    why: 'The not-needed test of a start that never came is applied to an ON that was written and did not take effect: "completed" over "did not take effect".',
  },
  {
    id: 'CNC-F-xxvii. ★★★ an unconfirmed ON switched off early is not flagged',
    file: NOTIFY,
    find: UNCONF_FLAG,
    to: swap(UNCONF_FLAG, 'flagged: {', 'flagged: earlyOff != null ? null : {'),
    why: '"completed", under "reserve restored to 16%", on an ON the panel never confirmed and the run backstop switched off.',
  },
  {
    id: 'CNC-F-xxviii. ★★★ an unconfirmed ON is not flagged where the pool closed at or above its stop',
    file: NOTIFY,
    find: UNCONF_FLAG,
    to: swap(UNCONF_FLAG, 'flagged: {', 'flagged: poolRead != null && poolRead >= fc.stopPct ? null : {'),
    why: 'A close at 90% clears an ON nothing read back and an OFF short of its stop: the close reading is taken for a confirmation.',
  },

  /* ── L: the slots left out ── */
  {
    id: 'CNC-L-i. ★★★ a left-out list that is no list is read as one',
    file: NOTIFY,
    find: LEFT_OUT,
    to: swap(LEFT_OUT, 'Array.isArray(cost.leftOutSlots)', 'cost.leftOutSlots != null'),
    why: 'A left-out field kept as text or as a number on a damaged record: the builder throws, and the summary is never sent.',
  },
  {
    id: 'CNC-L-ii. ★★★ the left-out list names what is no whole number',
    file: NOTIFY,
    find: LEFT_OUT,
    to: swap(LEFT_OUT, 'Number.isInteger(n) && n >= 1', 'n >= 1'),
    why: '"slot(s) 1.5 not switched on", "slot(s) Infinity not switched on".',
  },
  {
    id: 'CNC-L-iii. ★★★ the left-out list names what is no positive number',
    file: NOTIFY,
    find: LEFT_OUT,
    to: swap(LEFT_OUT, 'Number.isInteger(n) && n >= 1', 'Number.isInteger(n)'),
    why: '"slot(s) 0 not switched on", "slot(s) -1 not switched on": slots no panel has.',
  },
  {
    id: 'CNC-L-iv. ★★★ the left-out list names slot 0',
    file: NOTIFY,
    find: LEFT_OUT,
    to: swap(LEFT_OUT, 'n >= 1', 'n >= 0'),
    why: '"slot(s) 0 not switched on": the panel\'s slots count from 1.',
  },
  {
    id: 'CNC-L-v. ★★★ the left-out list never names slot 1',
    file: NOTIFY,
    find: LEFT_OUT,
    to: swap(LEFT_OUT, 'n >= 1', 'n > 1'),
    why: 'A night whose ON was not sent to slot 1 says nothing of it.',
  },
  {
    id: 'CNC-L-vi. ★★★ a slot left out is never named',
    file: NOTIFY,
    find: LEFT_OUT_IF,
    to: swap(LEFT_OUT_IF, 'leftOut.length > 0', 'leftOut.length < 0'),
    why: 'A force-charge that ran on two slots of three reads as one that ran on all of them.',
  },
  {
    id: 'CNC-L-vii. ★★★ the left-out clause is said with no slot left out',
    file: NOTIFY,
    find: LEFT_OUT_IF,
    to: swap(LEFT_OUT_IF, 'leftOut.length > 0', 'leftOut.length >= 0'),
    why: '"; slot(s)  not switched on (named out of the backup pool by the pool alarm)" on every night.',
  },
  {
    id: 'CNC-L-viii. ★★★ one slot left out is not named',
    file: NOTIFY,
    find: LEFT_OUT_IF,
    to: swap(LEFT_OUT_IF, 'leftOut.length > 0', 'leftOut.length > 1'),
    why: 'A night whose ON was not sent to one slot (the usual case: one Core out of the pool) says nothing of it.',
  },
  {
    id: 'CNC-L-ix. ★★★ the left-out clause names its first slot only',
    file: NOTIFY,
    find: LEFT_OUT_WORDS,
    to: swap(LEFT_OUT_WORDS, "leftOut.join(', ')", 'leftOut[0]'),
    why: '"slot(s) 1 not switched on" on a night slots 1 and 3 were left out.',
  },
  {
    id: 'CNC-L-x. ★★★ the left-out clause does not say why',
    file: NOTIFY,
    find: LEFT_OUT_WORDS,
    to: swap(LEFT_OUT_WORDS, ' (named out of the backup pool by the pool alarm)', ''),
    why: '"; slot(s) 1 not switched on": it reads as a failure, with nothing of the pool alarm that named the Core out.',
  },
  {
    id: 'CNC-L-xi. ★★★ the left-out clause says the slot was switched on',
    file: NOTIFY,
    find: LEFT_OUT_WORDS,
    to: swap(LEFT_OUT_WORDS, ' not switched on', ' switched on'),
    why: '"; slot(s) 1 switched on (named out of the backup pool by the pool alarm)": the opposite of what the record holds.',
  },
  {
    id: 'CNC-L-xii(a). ★★★ on a night that ran the slots left out follow the close clause',
    file: NOTIFY,
    find: RAN_NIGHT,
    to: swap(RAN_NIGHT, '${leftOutWords}${close}', '${close}${leftOutWords}'),
    why: '"against the ~56.7% the evening notice named; slot(s) 1 not switched on (…); the reserve is restored": the slot reads as part of the close.',
  },
  {
    id: 'CNC-L-xii(b). ★★★ on a failed night the slots left out follow the close clause',
    file: NOTIFY,
    find: FAILED_NIGHT,
    to: swap(FAILED_NIGHT, '${leftOutWords}${close}', '${close}${leftOutWords}'),
    why: '"the pool read 49% at the close, against the ~56.7% the evening notice named; slot(s) 1 not switched on (…)".',
  },
  {
    id: 'CNC-L-xii(c). ★★★ on an unconfirmed night at its stop the slots left out follow the close clause',
    file: NOTIFY,
    find: UNCONF_REACHED_NIGHT,
    to: swap(UNCONF_REACHED_NIGHT, '${leftOutWords}${close}', '${close}${leftOutWords}'),
    why: '"the pool read 57% at the close, against the ~56.7% the evening notice named; slot(s) 1 not switched on (…)".',
  },
  {
    id: 'CNC-L-xii(d). ★★★ on an unconfirmed night the slots left out follow the close clause',
    file: NOTIFY,
    find: UNCONF_NIGHT,
    to: swap(UNCONF_NIGHT, '${leftOutWords}${close}', '${close}${leftOutWords}'),
    why: '"the pool read 49% at the close, against the ~56.7% the evening notice named; slot(s) 3 not switched on (…)".',
  },
  {
    id: 'CNC-L-xiii(a). ★★★ a night that ran never names a slot left out',
    file: NOTIFY,
    find: RAN_NIGHT,
    to: swap(RAN_NIGHT, '${leftOutWords}', ''),
    why: 'A force-charge that reached its stop on two slots of three reads as one that ran on all of them.',
  },
  {
    id: 'CNC-L-xiii(b). ★★★ a failed night never names a slot left out',
    file: NOTIFY,
    find: FAILED_NIGHT,
    to: swap(FAILED_NIGHT, '${leftOutWords}', ''),
    why: 'A failed ON that was sent to two slots of three says nothing of the third.',
  },
  {
    id: 'CNC-L-xiii(c). ★★★ an unconfirmed night at its stop never names a slot left out',
    file: NOTIFY,
    find: UNCONF_REACHED_NIGHT,
    to: swap(UNCONF_REACHED_NIGHT, '${leftOutWords}', ''),
    why: '"with no readback showing every slot ON; the pool read 57% at the close" on a night slot 1 was never sent the ON.',
  },
  {
    id: 'CNC-L-xiii(d). ★★★ an unconfirmed night never names a slot left out',
    file: NOTIFY,
    find: UNCONF_NIGHT,
    to: swap(UNCONF_NIGHT, '${leftOutWords}', ''),
    why: '"the panel never confirmed it; the pool read 49% at the close" on a night slot 3 was never sent the ON.',
  },
  {
    id: 'CNC-L-xiv. ★★★ a night whose force-charge never started names a slot left out',
    file: NOTIFY,
    find: NEVER_NIGHT,
    to: swap(NEVER_NIGHT, '${close}', '${leftOutWords}${close}'),
    why: '"never started; slot(s) 1 not switched on (…)": a slot is singled out on a night no slot was sent the ON.',
  },
  {
    id: 'CNC-L-xv. ★★★ a failed night names the slots left out ahead of what ended its force-charge',
    file: NOTIFY,
    find: FAILED_NIGHT,
    to: swap(FAILED_NIGHT, '${ended}${leftOutWords}', '${leftOutWords}${ended}'),
    why: '"; slot(s) 1 not switched on (…); it was switched off at 2:30am (the run backstop)": "it" reads as the slot.',
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
    to: swap(COST_CALL, 'costNightAccount(o.cost, fc,', 'costNightAccount(null, fc,'),
    why: 'The 2026-11-16 night again: "completed", "reserve restored to 16%", no close stated.',
  },
  {
    id: 'CNC-B-vi. ★★★ the account is handed "reserve raised" whatever the reserve did',
    file: NOTIFY,
    find: COST_CALL,
    to: swap(COST_CALL, '{ reserve, toward,', '{ reserve: `reserve raised to ${raised}`, toward,'),
    why: 'A night whose reserve stood, or was held as a floor, says "reserve raised to 50%".',
  },
  {
    id: 'CNC-B-vii. ★★★ the account is handed no stop words',
    file: NOTIFY,
    find: COST_CALL,
    to: swap(COST_CALL, ' toward,', " toward: '',"),
    why: '"force-charge ran; the pool read…", "force-charge never started": the ~56.7% stop goes unnamed.',
  },
  {
    id: 'CNC-B-viii. ★★★ the account is handed no expected figure',
    file: NOTIFY,
    find: COST_CALL,
    to: swap(COST_CALL, ' note,', " note: '',"),
    why: '"(~6.2 kWh expected)" is dropped from a night whose force-charge ran.',
  },
  {
    id: 'CNC-B-ix. ★★★ the account is handed "restored" whatever the restore did',
    file: NOTIFY,
    find: COST_CALL,
    to: swap(COST_CALL, ' restored,', ' restored: `the reserve is restored to ${o.restorePct}%. `,'),
    why: '"the reserve is restored to 16%" on a restore the panel has not read back, and on a night no restore was due.',
  },
  {
    id: 'CNC-B-xi. ★★★ the account is not handed the grid loss',
    file: NOTIFY,
    find: COST_CALL,
    to: swap(COST_CALL, 'gridLost: o.gridLost === true', 'gridLost: false'),
    why: 'A never-started account drops "(the grid read as lost)".',
  },
  {
    id: 'CNC-B-xii. ★★★ a grid loss nothing read is handed on',
    file: NOTIFY,
    find: COST_CALL,
    to: swap(COST_CALL, 'o.gridLost === true', 'o.gridLost !== false'),
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
    why: '"ran toward ~56.7% and was switched off at 3:12am (cost)".',
  },
  {
    id: 'CNC-X-xii. ★★★ no OFF time is passed',
    file: INDEX,
    find: COST_L2,
    to: "        offReason: state.forceChargeOffReason, offAtMs: null, onReissues: state.forceChargeOnRetries, /* MUTANT */",
    why: 'A target OFF is never "reached ~S% at <clock>"; an early OFF says "before the window close".',
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
