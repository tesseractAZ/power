#!/usr/bin/env node
/**
 * mutate-far-window.mjs — committed harness for v1.206.0: a window that opens a day or more after the plan is not "tonight".
 *
 * On Saturday 2026-11-14 at 21:30 the push read "charging to ~90% tonight (~46.6 kWh)" / "Charging the backup pool to ~90%
 * overnight" for a window opening Monday 00:00, 26.5 h out. Every overnight push shape now names such a window, says no charge is
 * planned for tonight, and says of the window only what is armed at that moment; the card shows its clocks with their weekday. Inside
 * 24 h nothing moves.
 *
 * (R) the rule (siteTime.windowBeyondTonight, fmtSiteDayHm's own) and the window's words (chargeText.farWindowWords, farNoteWords).
 *     Mutants R-i..xi.
 * (P) the push (notify.buildNightChargeMessage): every far shape, its lead, its island lows (said once where they are the same; a
 *     reserve read above the write prices no charge; a night that stands names no write), its notes, its later-arm rule, what each
 *     hold, refusal and missing plan says is armed, and the near words untouched. Mutants P-i..xxxii (no P-xv: the island lows name no
 *     day, so nothing reads the instant of the low).
 * (C) the card (web siteTime.ts, nightChargeText.ts, NightChargeCard.tsx): the weekday clock, the far window, the banner. Mutants
 *     C-i..xvii; those on the component are killed by source pins (it cannot be imported in a node test), labelled as such.
 *
 *   node scripts/mutate-far-window.mjs [--only <id prefix>]
 *
 * ★ Anchor-asserted (each anchor matches exactly once); every mutant must TYPECHECK (one that does not is reported INVALID and fails
 *   the run); each mutant names the test files that must kill it, and only those run for it. Every failing test of every mutant is
 *   printed (nameEveryKiller), so the log shows what holds each behaviour, not only that something does.
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = resolve(REPO, 'server/src/siteTime.ts');
const CTEXT = resolve(REPO, 'server/src/chargeText.ts');
const NOTIFY = resolve(REPO, 'server/src/notify.ts');
const WSITE = resolve(REPO, 'web/src/siteTime.ts');
const WTEXT = resolve(REPO, 'web/src/cards/nightChargeText.ts');
const CARD = resolve(REPO, 'web/src/cards/NightChargeCard.tsx');

const T_FAR = 'test/farWindowText.test.ts';
const T_NEAR = 'test/overnightNearIdentityYear.test.ts';
const T_GOLD = 'test/overnightTextGolden.test.ts';
const T_CANCEL = 'test/chargeCardCancel.test.ts';
const T_UNHELD = 'test/lineNightUnheld.test.ts';
const T_RN = 'test/refusedNotes.test.ts';
const T_AO = 'test/lineAtOpenAllowance.test.ts';

// The armed far push's closing sentence, and the three lines that carry it (two mutants change the first two ways).
const TAIL_ARMED = "      ? `${farNoteWords(tail)} The figures above are this evening's; a later evening run that arms the same window replaces this arm.`";
const TAIL_ADVISORY = '      : tail;\n  }';

const MUTANTS = [
  /* ── R: the rule and the window's words ── */
  {
    id: 'R-i. ★★★ exactly 24 h is still "tonight"',
    file: SITE, tests: [T_FAR],
    find: '  return Number.isFinite(ms) && Number.isFinite(nowMs) && ms - nowMs >= 24 * HOUR_MS;',
    to: '  return Number.isFinite(ms) && Number.isFinite(nowMs) && ms - nowMs > 24 * HOUR_MS; /* MUTANT */',
    why: 'The title would call a window "tonight" at the instant the cancel deadline and the window entities name its weekday.',
  },
  {
    id: 'R-ii. ★★★ the rule is two days (the defect: a Saturday plan for Monday, 26.5 h out, reads "tonight")',
    file: SITE, tests: [T_FAR],
    find: '  return Number.isFinite(ms) && Number.isFinite(nowMs) && ms - nowMs >= 24 * HOUR_MS;',
    to: '  return Number.isFinite(ms) && Number.isFinite(nowMs) && ms - nowMs >= 48 * HOUR_MS; /* MUTANT */',
    why: '"charging to ~90% tonight" on a Saturday evening, for a window that opens on Monday.',
  },
  {
    id: 'R-iii. ★★ an instant that is not finite is far',
    file: SITE, tests: [T_FAR],
    find: '  return Number.isFinite(ms) && Number.isFinite(nowMs) && ms - nowMs >= 24 * HOUR_MS;',
    to: '  return Number.isFinite(nowMs) && ms - nowMs >= 24 * HOUR_MS; /* MUTANT */',
    why: 'The namer throws on it, the push builder with it, and the evening job never arms.',
  },
  {
    id: 'R-iv. ★★ a clock that is not finite makes every window far',
    file: SITE, tests: [T_FAR],
    find: '  return Number.isFinite(ms) && Number.isFinite(nowMs) && ms - nowMs >= 24 * HOUR_MS;',
    to: '  return Number.isFinite(ms) && ms - nowMs >= 24 * HOUR_MS; /* MUTANT */',
    why: 'As R-iii, on the plan\'s clock.',
  },
  {
    id: 'R-v. ★★★ every window is worded as far (the rule is not read)',
    file: CTEXT, tests: [T_NEAR, T_GOLD, T_FAR],
    find: '  if (window == null || !Number.isFinite(window.endMs) || !windowBeyondTonight(window.startMs, nowMs)) return null;',
    to: '  if (window == null || !Number.isFinite(window.endMs) || !Number.isFinite(window.startMs) || !Number.isFinite(nowMs)) return null; /* MUTANT */',
    why: 'Every weeknight push changes its words.',
  },
  {
    id: 'R-vi. ★★ the open is given the close\'s clock',
    file: CTEXT, tests: [T_FAR],
    find: '    opens: `${dayText(dayWord(window.startMs, nowMs))} at ${phxClock(window.startMs)}`,',
    to: '    opens: `${dayText(dayWord(window.startMs, nowMs))} at ${phxClock(window.endMs)}`, /* MUTANT */',
    why: '"the charge window opens Monday at 5:00 AM".',
  },
  {
    id: 'R-vii. ★★ the open is named by the close\'s day',
    file: CTEXT, tests: [T_FAR],
    find: '    opens: `${dayText(dayWord(window.startMs, nowMs))} at ${phxClock(window.startMs)}`,',
    to: '    opens: `${dayText(dayWord(window.endMs, nowMs))} at ${phxClock(window.startMs)}`, /* MUTANT */',
    why: 'A window that opens tomorrow at 10 PM and closes on Monday would be said to open on Monday.',
  },
  {
    id: 'R-viii. ★★ a far note keeps "tonight\'s"',
    file: CTEXT, tests: [T_FAR],
    find: `    .replaceAll("tonight's ", "that window's ")\n`,
    to: '    /* MUTANT */\n',
    why: '"No charge is planned for tonight" above "tonight\'s 52.2% outage line".',
  },
  {
    id: 'R-ix. ★★ a far note keeps "needs no buy tonight"',
    file: CTEXT, tests: [T_FAR],
    find: "    .replaceAll('Resilience needs no buy tonight', 'Resilience needs no buy in that window')\n",
    to: '    /* MUTANT */\n',
    why: 'The economic note speaks of tonight on a night with no window.',
  },
  {
    id: 'R-x. ★★ a far note keeps "tomorrow morning\'s PV headroom"',
    file: CTEXT, tests: [T_FAR],
    find: "    .replaceAll('tomorrow morning’s PV headroom', 'the PV headroom of the morning after that window')\n",
    to: '    /* MUTANT */\n',
    why: 'On a Saturday the morning after the window is Monday\'s.',
  },
  {
    id: 'R-xi. ★★ a far note keeps "if the car charges overnight"',
    file: CTEXT, tests: [T_FAR],
    find: "    .replaceAll('if the car charges overnight', 'if the car charges in that window');",
    to: '    ; /* MUTANT */',
    why: 'The EV note speaks of tonight on a night with no window.',
  },

  /* ── P: the push ── */
  {
    id: 'P-i. ★★★ the push never reads the window (the defect)',
    file: NOTIFY, tests: [T_FAR, T_RN, T_AO],
    find: '  const far = plan != null ? farWindowWords(plan.window, plan.generatedAt) : null;',
    to: '  const far = plan != null && (false as boolean) ? farWindowWords(plan.window, plan.generatedAt) : null; /* MUTANT */',
    why: '"charging to ~90% tonight (~46.6 kWh)" for a window that opens on Monday.',
  },
  {
    id: 'P-ii. ★★★ far is judged on the wall clock, not the plan\'s',
    file: NOTIFY, tests: [T_FAR],
    find: '  const far = plan != null ? farWindowWords(plan.window, plan.generatedAt) : null;',
    to: '  const far = plan != null ? farWindowWords(plan.window, Date.now()) : null; /* MUTANT */',
    why: 'The builder is no longer pure: a plan re-rendered later changes its words, and its window is named from the wrong day.',
  },
  {
    id: 'P-iii. ★★ a far no-plan push keeps "no plan tonight … nothing will be charged"',
    file: NOTIFY, tests: [T_FAR],
    find: '    if (far != null) {\n      return {\n        ...base,\n        title: `Night-charge: no plan for ${far.when}`,',
    to: '    if ((false as boolean) && far != null) { /* MUTANT */\n      return {\n        ...base,\n        title: `Night-charge: no plan for ${far.when}`,',
    why: 'A later evening run can still plan and arm that window.',
  },
  {
    id: 'P-iv. ★★ a far hold whose window cannot cover the cushion keeps tonight\'s words',
    file: NOTIFY, tests: [T_FAR],
    find: '    if (far != null && plan.cushionShortfall) {',
    to: '    if ((false as boolean) && far != null && plan.cushionShortfall) { /* MUTANT */',
    why: '"no charge tonight … nothing will be charged" of Monday\'s window.',
  },
  {
    id: 'P-v. ★★ a far hold under the minimum buy keeps tonight\'s words',
    file: NOTIFY, tests: [T_FAR],
    find: '    if (far != null && plan.requiredExtraKwh > 0) {',
    to: '    if ((false as boolean) && far != null && plan.requiredExtraKwh > 0) { /* MUTANT */',
    why: 'As P-iv.',
  },
  {
    id: 'P-vi. ★★ a far hold whose cushion holds keeps tonight\'s words',
    file: NOTIFY, tests: [T_FAR],
    find: '    if (far != null) {\n      return {\n        ...base,\n        title: `Night-charge: hold for ${far.when} (no charge needed)`,',
    to: '    if ((false as boolean) && far != null) { /* MUTANT */\n      return {\n        ...base,\n        title: `Night-charge: hold for ${far.when} (no charge needed)`,',
    why: 'As P-iv.',
  },
  {
    id: 'P-vii. ★★★ a far hold still says "Nothing will be charged"',
    file: NOTIFY, tests: [T_FAR],
    find: '          + `${pct(line)} floor+cushion line. Nothing is armed for it.${provisionalHold}`,',
    to: '          + `${pct(line)} floor+cushion line. Nothing will be charged in it.${provisionalHold}`, /* MUTANT */',
    why: 'A promise about a window a later evening run plans again.',
  },
  {
    id: 'P-viii. ★★★ a far refused push keeps tonight\'s words',
    file: NOTIFY, tests: [T_FAR, T_RN, T_AO],
    find: '    if (far != null) {\n      const farRefusedNotes',
    to: '    if ((false as boolean) && far != null) { /* MUTANT */\n      const farRefusedNotes',
    why: '"planned charge NOT armed tonight … will not charge tonight" on a night with no window.',
  },
  {
    id: 'P-ix. ★★★ a far refused push promises the window',
    file: NOTIFY, tests: [T_FAR, T_RN],
    find: '            + `Nothing is armed for that window.${farRefusedNotes}`,',
    to: '            + `The add-on will not charge in that window.${farRefusedNotes}`, /* MUTANT */',
    why: 'A later evening run arms that window once the refusal clears.',
  },
  {
    id: 'P-x. ★★ the basis sentence of a far refused push is reworded',
    file: NOTIFY, tests: [T_FAR],
    find: "      const farRefusedNotes = cushionOnlyPushText(plan, 'short') + farNoteWords(refusedNote);",
    to: "      const farRefusedNotes = farNoteWords(cushionOnlyPushText(plan, 'short') + refusedNote); /* MUTANT */",
    why: 'farNoteWords is for the builder\'s own notes: a refusal\'s text is another module\'s.',
  },
  {
    id: 'P-xi. ★★ the refusal reason of a far refused push is reworded',
    file: NOTIFY, tests: [T_FAR],
    find: '            `The plan for the ${far.when} window calls for a charge, but ${write} was not armed — ${armRefused}. `',
    to: '            `The plan for the ${far.when} window calls for a charge, but ${write} was not armed — ${farNoteWords(armRefused)}. ` /* MUTANT */',
    why: 'As P-x.',
  },
  {
    id: 'P-xii. ★★★ the far lead is dropped',
    file: NOTIFY, tests: [T_FAR],
    find: '    farLead = `No charge is planned for tonight: the charge window opens ${far.opens}. `;',
    to: "    farLead = ''; /* MUTANT */",
    why: 'Nothing says plainly that no charge is planned for tonight.',
  },
  {
    id: 'P-xiii. ★★ the same island low is said twice',
    file: NOTIFY, tests: [T_FAR],
    find: '    const sameLow = lowNo != null && lowWith != null && round1(lowNo) === round1(lowWith);',
    to: '    const sameLow = (false as boolean) && lowNo != null && lowWith != null && round1(lowNo) === round1(lowWith); /* MUTANT */',
    why: '"~0% without this charge; with it ~0%".',
  },
  {
    id: 'P-xiv. ★★★ two different island lows are said as one',
    file: NOTIFY, tests: [T_FAR],
    find: '    const sameLow = lowNo != null && lowWith != null && round1(lowNo) === round1(lowWith);',
    to: '    const sameLow = lowNo != null && lowWith != null; /* MUTANT */',
    why: 'The low without the charge is dropped: "~22.1% with or without this charge" where it is 0% without.',
  },
  {
    id: 'P-xvi. ★★ a far push\'s notes keep tonight\'s words',
    file: NOTIFY, tests: [T_FAR],
    find: "    const farNotes = farNoteWords(`${shortfallNote}${overBuyNote}${economicNote}${held ? '' : evNote}`);",
    to: "    const farNotes = `${shortfallNote}${overBuyNote}${economicNote}${held ? '' : evNote}`; /* MUTANT */",
    why: 'As R-viii..xi, at the call.',
  },
  {
    id: 'P-xvii. ★★ a far push\'s supervised tail keeps "for tonight\'s … outage line"',
    file: NOTIFY, tests: [T_FAR],
    find: TAIL_ARMED,
    to: "      ? `${tail} The figures above are this evening's; a later evening run that arms the same window replaces this arm.` /* MUTANT */",
    why: 'As R-viii, in the force-charge clause.',
  },
  {
    id: 'P-xviii. ★★★ an armed far push does not say what a later arm does to it',
    file: NOTIFY, tests: [T_FAR],
    find: TAIL_ARMED,
    to: '      ? farNoteWords(tail) /* MUTANT */',
    why: 'Saturday\'s figures read as final; an arm a later evening run makes for the same window replaces them.',
  },
  {
    id: 'P-xix. ★★ the later-arm rule is said with nothing armed (advisory)',
    file: NOTIFY, tests: [T_FAR],
    find: TAIL_ADVISORY,
    to: "      : `${tail} The figures above are this evening's; a later evening run that arms the same window replaces this arm.`; /* MUTANT */\n  }",
    why: '"replaces this arm" where no arm exists.',
  },
  {
    id: 'P-xx. ★★★ a far reserve hold keeps "held at 50% tonight"',
    file: NOTIFY, tests: [T_FAR],
    find: '    if (far != null) {\n      return {\n        ...base,\n        title: `Night-charge: ${supervised ? `reserve held at ${reserveText} ${far.when}`',
    to: '    if ((false as boolean) && far != null) { /* MUTANT */\n      return {\n        ...base,\n        title: `Night-charge: ${supervised ? `reserve held at ${reserveText} ${far.when}`',
    why: 'The reserve is not held tonight: the write is two days out.',
  },
  {
    id: 'P-xxi. ★★★ a far charge keeps "charging … tonight"',
    file: NOTIFY, tests: [T_FAR],
    find: '  if (far != null) {\n    const farKwh = expected == null ? null : kwh(expected);',
    to: '  if ((false as boolean) && far != null) { /* MUTANT */\n    const farKwh = expected == null ? null : kwh(expected);',
    why: 'The defect, on the charge shape alone.',
  },
  {
    id: 'P-xxii. ★★ the far title loses its expected draw',
    file: NOTIFY, tests: [T_FAR],
    find: "        + `${farKwh == null ? '' : ` (~${farKwh})`}${cushionOnlyTitle}`,",
    to: '        + `${cushionOnlyTitle}`, /* MUTANT */',
    why: 'The title states the charge: its level and its expected draw.',
  },
  {
    id: 'P-xxiii. ★★ the far title loses "outage cushion only"',
    file: NOTIFY, tests: [T_FAR],
    find: "        + `${farKwh == null ? '' : ` (~${farKwh})`}${cushionOnlyTitle}`,",
    to: "        + `${farKwh == null ? '' : ` (~${farKwh})`}`, /* MUTANT */",
    why: 'A cushion-only plan says so in its title, far or near.',
  },
  /* v1.206.0 review — the sub-branches the fixture year reaches rarely or never, and what each hold and missing plan says is armed. */
  {
    id: 'P-xxiv. ★★★ a reserve read above the write is priced as a charge',
    file: NOTIFY, tests: [T_FAR],
    find: "    const atTarget = plan.cushionEnvelopeReason === 'reserveAtTarget';",
    to: "    const atTarget = (false as boolean) && plan.cushionEnvelopeReason === 'reserveAtTarget'; /* MUTANT */",
    why: '"~0% without this charge; with it ~64%" on a night no write is due: the figure "with" is the sized buy, which nothing is due to make.',
  },
  {
    id: 'P-xxv. ★★ a night that stands with nothing expected names a write',
    file: NOTIFY, tests: [T_FAR],
    find: "    const thisBuy = held && !stands ? 'this write' : 'this charge';",
    to: "    const thisBuy = held ? 'this write' : 'this charge'; /* MUTANT */",
    why: '"without this write" where the reserve already reads the target and no write is due.',
  },
  {
    id: 'P-xxvi. ★★ the far hold\'s two figures are swapped (the pack\'s close said of the whole house)',
    file: NOTIFY, tests: [T_FAR],
    find: '          `No charge is needed in the ${far.when} window — even if the grid were lost from now on, ${wholeHouse',
    to: '          `No charge is needed in the ${far.when} window — even if the grid were lost from now on, ${!wholeHouse /* MUTANT */',
    why: 'The legacy basis has no pack-at-close figure: its low is the whole house\'s, and the islanded basis\'s is the pack at the close.',
  },
  {
    id: 'P-xxvii. ★★ a far charge with no expected figure states one',
    file: NOTIFY, tests: [T_FAR],
    find: '    const farKwh = expected == null ? null : kwh(expected);',
    to: '    const farKwh = kwh(expected); /* MUTANT */',
    why: '"(~—)" in the title and "~— of grid energy expected": a figure the plan does not carry.',
  },
  {
    id: 'P-xxviii. ★★★ a far no-plan push still says "nothing will be charged"',
    file: NOTIFY, tests: [T_FAR],
    find: '          `No charge plan this evening for the ${far.when} window — ${reason}, so nothing is armed for it. `',
    to: '          `No charge plan this evening for the ${far.when} window — ${reason}, so nothing will be charged in it. ` /* MUTANT */',
    why: 'A promise about a window a later evening run can plan and arm.',
  },
  {
    id: 'P-xxix. ★★★ a far hold whose window cannot cover the cushion still says "nothing will be charged"',
    file: NOTIFY, tests: [T_FAR],
    find: '          + `enough to clear the minimum buy, so nothing is armed for it.${farNoteWords(shortfallNote + evNote)}${provisionalHold}`,',
    to: '          + `enough to clear the minimum buy, so nothing will be charged in it.${farNoteWords(shortfallNote + evNote)}${provisionalHold}`, /* MUTANT */',
    why: 'As P-xxviii.',
  },
  {
    id: 'P-xxx. ★★★ a far hold under the minimum buy still says "nothing will be charged"',
    file: NOTIFY, tests: [T_FAR],
    find: '          + `top-up, under the minimum buy, so nothing is armed for it.${provisionalHold}`,',
    to: '          + `top-up, under the minimum buy, so nothing will be charged in it.${provisionalHold}`, /* MUTANT */',
    why: 'As P-xxviii.',
  },
  {
    id: 'P-xxxi. ★★ the basis sentence of a far hold is reworded with its notes',
    file: NOTIFY, tests: [T_FAR],
    find: '          + `enough to clear the minimum buy, so nothing is armed for it.${farNoteWords(shortfallNote + evNote)}${provisionalHold}`,',
    to: '          + `enough to clear the minimum buy, so nothing is armed for it.${farNoteWords(shortfallNote + evNote + provisionalHold)}`, /* MUTANT */',
    why: 'farNoteWords is for the builder\'s own notes: a basis sentence is another module\'s text (as P-x, on the hold).',
  },
  {
    id: 'P-xxxii. ★★ the far hold\'s notes keep tonight\'s words',
    file: NOTIFY, tests: [T_FAR],
    find: '          + `enough to clear the minimum buy, so nothing is armed for it.${farNoteWords(shortfallNote + evNote)}${provisionalHold}`,',
    to: '          + `enough to clear the minimum buy, so nothing is armed for it.${shortfallNote + evNote}${provisionalHold}`, /* MUTANT */',
    why: '"if the car charges overnight" on a night with no window.',
  },

  /* ── C: the card ── */
  {
    id: 'C-i. ★★★ the card: exactly 24 h is still inside tonight',
    file: WSITE, tests: [T_FAR],
    find: '  return ms != null && Number.isFinite(ms) && Number.isFinite(nowMs) && ms - nowMs >= 24 * HOUR_MS;',
    to: '  return ms != null && Number.isFinite(ms) && Number.isFinite(nowMs) && ms - nowMs > 24 * HOUR_MS; /* MUTANT */',
    why: 'The banner and the window entities would disagree for an instant.',
  },
  {
    id: 'C-ii. ★★★ the weekday is the browser\'s, not the site\'s',
    file: WSITE, tests: [T_FAR],
    find: "    const wd = new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'short' })",
    to: "    const wd = new Intl.DateTimeFormat('en-US', { weekday: 'short' }) /* MUTANT */",
    why: 'A viewer elsewhere reads the wrong day for the write.',
  },
  {
    id: 'C-iii. ★★ the weekday is dropped',
    file: WSITE, tests: [T_FAR],
    find: '    return wd ? `${wd} ${hm}` : hm;',
    to: '    return hm; /* MUTANT */',
    why: 'The bare "00:00" a Saturday evening read as that night\'s midnight.',
  },
  {
    id: 'C-iv. ★★★ the card\'s far window: exactly 24 h is near',
    file: WTEXT, tests: [T_FAR],
    find: '  if (s - nowMs < 24 * 3_600_000) return null;',
    to: '  if (s - nowMs <= 24 * 3_600_000) return null; /* MUTANT */',
    why: 'As C-i.',
  },
  {
    id: 'C-v. ★★ the card\'s far window names its close as its open',
    file: WTEXT, tests: [T_FAR],
    find: '  const opens = weekdayHm(s);',
    to: '  const opens = weekdayHm(e); /* MUTANT */',
    why: '"the charge window opens Mon 05:00".',
  },
  {
    id: 'C-vi. ★★★ the banner ignores a far window',
    file: WTEXT, tests: [T_FAR],
    find: '  return far ? farBannerState(s) : s;',
    to: '  return s; /* MUTANT */',
    why: '"Cancel tonight" on a write two days out.',
  },
  {
    id: 'C-vii. ★★★ the banner is far by default',
    file: WTEXT, tests: [T_FAR, T_CANCEL],
    find: 'reservePct: number | null = null, far = false): BannerState {',
    to: 'reservePct: number | null = null, far = true): BannerState { /* MUTANT */',
    why: 'Every weeknight banner changes its Cancel.',
  },
  {
    id: 'C-viii. ★★ a far banner keeps "Cancel tonight"',
    file: WTEXT, tests: [T_FAR],
    find: "    cancel: s.cancel === 'Cancel tonight' ? FAR_CANCEL_LABEL : s.cancel,",
    to: '    cancel: s.cancel, /* MUTANT */',
    why: 'As C-vi, in the mapping.',
  },
  {
    id: 'C-ix. ★★ a far cancelled banner keeps "no write tonight"',
    file: WTEXT, tests: [T_FAR],
    find: "    text: s.text === 'Cancelled — no write tonight.' ? FAR_CANCELLED_TEXT : s.text,",
    to: '    text: s.text, /* MUTANT */',
    why: 'No write was due tonight to begin with.',
  },
  {
    id: 'C-xvi. ★★★ the card\'s rule is two days (a Saturday evening\'s banner for Monday reads "Cancel tonight")',
    file: WSITE, tests: [T_FAR],
    find: '  return ms != null && Number.isFinite(ms) && Number.isFinite(nowMs) && ms - nowMs >= 24 * HOUR_MS;',
    to: '  return ms != null && Number.isFinite(ms) && Number.isFinite(nowMs) && ms - nowMs >= 48 * HOUR_MS; /* MUTANT */',
    why: 'The defect, on the card\'s banner: 26.5 h out reads as tonight.',
  },
  {
    id: 'C-xvii. ★★★ the card\'s far window: the rule is two days',
    file: WTEXT, tests: [T_FAR],
    find: '  if (s - nowMs < 24 * 3_600_000) return null;',
    to: '  if (s - nowMs < 48 * 3_600_000) return null; /* MUTANT */',
    why: 'The defect, on the card\'s headline: "in the 00:00–05:00 window" on a Saturday evening.',
  },
  // The component (web/src/cards/NightChargeCard.tsx) cannot be imported in a node test: these are killed by source pins.
  {
    id: 'C-x. ★★★ [source pin] the card never judges the plan\'s window far',
    file: CARD, tests: [T_FAR],
    find: '  const far = farCardWindow(plan.window, Date.now(), weekdayHm);',
    to: '  const far = (false as boolean) ? farCardWindow(plan.window, Date.now(), weekdayHm) : null; /* MUTANT */',
    why: '"in the 00:00–05:00 window" on a Saturday evening, for Monday\'s window.',
  },
  {
    id: 'C-xi. ★★★ [source pin] the banner\'s deadline keeps the bare clock',
    file: CARD, tests: [T_FAR, T_CANCEL, T_UNHELD],
    find: 'const state = actuationBannerState(actuation, (far ? weekdayHm : hhmm)(actuation.cancelDeadlineMs), reservePct, far);',
    to: 'const state = actuationBannerState(actuation, hhmm(actuation.cancelDeadlineMs), reservePct, far); /* MUTANT */',
    why: '"reserve → 50% at 00:00" on a Saturday evening, for Monday 00:00.',
  },
  {
    id: 'C-xii. ★★ [source pin] the banner is not told its window is far',
    file: CARD, tests: [T_FAR, T_CANCEL, T_UNHELD],
    find: 'const state = actuationBannerState(actuation, (far ? weekdayHm : hhmm)(actuation.cancelDeadlineMs), reservePct, far);',
    to: 'const state = actuationBannerState(actuation, (far ? weekdayHm : hhmm)(actuation.cancelDeadlineMs), reservePct); /* MUTANT */',
    why: '"Cancel tonight" on a write two days out.',
  },
  {
    id: 'C-xiii. ★★ [source pin] the banner judges far on the wrong instant (the window\'s close)',
    file: CARD, tests: [T_FAR, T_CANCEL],
    find: '  const far = beyondTonight(actuation.windowStartMs, Date.now());',
    to: '  const far = beyondTonight(actuation.windowEndMs, Date.now()); /* MUTANT */',
    why: 'A window that opens in 20 h and closes in 25 h would be far.',
  },
  {
    id: 'C-xiv. ★★ [source pin] the line that says no charge is planned for tonight is not drawn',
    file: CARD, tests: [T_FAR],
    find: '      {far != null && !refused && !closedLead && (\n        <div className="text-xs text-muted mb-3 -mt-2">{farLeadText(far)}</div>\n      )}\n',
    to: '      {/* MUTANT */}\n',
    why: 'The card names the window\'s day but never says nothing happens tonight.',
  },
  {
    id: 'C-xv. ★★ [source pin] the window\'s close keeps the bare clock',
    file: CARD, tests: [T_FAR],
    find: '  const we = far != null ? weekdayHm(plan.window?.endMs) : hhmm(plan.window?.endMs);',
    to: '  const we = hhmm(plan.window?.endMs); /* MUTANT */',
    why: '"Mon 00:00–05:00": half a day name.',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs).
import { runMutantsParallel } from './lib/mutateParallel.mjs';
await runMutantsParallel({ name: 'mutate-far-window', mutants: MUTANTS, subset: [], root: REPO, perMutantTests: true, typecheck: true, fullSuite: false, nameEveryKiller: true });
