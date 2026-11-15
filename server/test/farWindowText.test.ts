import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { computeNightChargePlan, buildNightChargeInputs, type NightChargePlan } from '../src/nightChargeAdvisor.js';
import { buildNightChargeMessage } from '../src/notify.js';
import { eveningAnnouncement } from '../src/chargeAnnounce.js';
import { farWindowWords, farNoteWords } from '../src/chargeText.js';
import { windowBeyondTonight, fmtSiteDayHm } from '../src/siteTime.js';
import { farTextCases } from './fixtures/overnightFarTextCases.js';
import { legacyIdentityCases } from './fixtures/legacyIdentityFixtures.js';
import { MEASURED_SCALE } from './fixtures/measuredCushionLineFigures.js';
import { darkDeps } from './fixtures/cushionOnlyFigures.js';
import * as card from '../../web/src/cards/nightChargeText.js';
import { beyondTonight, fmtWeekdayHHMMIn, fmtHHMMIn } from '../../web/src/siteTime.js';

/**
 * ★★★ v1.206.0 — A WINDOW THAT OPENS A DAY OR MORE AFTER THE PLAN IS NOT "TONIGHT".
 *
 * On Saturday 2026-11-14 at 21:30 the push read "Night-charge: charging to ~90% tonight (~46.6 kWh)" / "Charging the backup pool to
 * ~90% overnight" for a window opening Monday 00:00, 26.5 h out; no write was due before Monday. Every overnight push shape now
 * names such a window, says no charge is planned for tonight, and says of the window only what is armed at that moment. Inside
 * 24 h nothing moves (overnightNearIdentityYear.test.ts, overnightTextGolden.test.ts).
 *
 * The expected words are written out (fixtures/overnightFarTextGolden.json: the far entries are the reference wording, written and
 * proof-read by hand against the wording table and never captured from the implementation; each far entry's `was`, every near entry
 * and every spoken notice is v1.205.1's, captured at 8f4b6748), and "far" is 86,400,000 ms written here, never the subject's own
 * predicate.
 */

const H = 3_600_000;
const H24 = 86_400_000;
const phx = (y: number, mo: number, d: number, h: number, mi = 0): number => Date.UTC(y, mo - 1, d, h + 7, mi);
const SAT = phx(2026, 11, 14, 21, 30);
const MON0 = phx(2026, 11, 16, 0);
const MON5 = phx(2026, 11, 16, 5);
const GOLDEN = JSON.parse(readFileSync(new URL('./fixtures/overnightFarTextGolden.json', import.meta.url), 'utf8')) as {
  cases: Array<{ name: string; kind: 'far' | 'near'; shape: string; push: { title: string; body: string }; spoken: { en: string; es: string } | null; was?: { title: string; body: string } }>;
};
const isFar = (p: NightChargePlan | null): boolean => p != null && p.window != null && p.window.startMs - p.generatedAt >= H24;

test('★★★ FW-1 the rule: a window is "beyond tonight" from exactly 24 h, the instant fmtSiteDayHm starts naming the weekday', () => {
  assert.equal(windowBeyondTonight(MON0, MON0 - H24), true, 'exactly 24 h');
  assert.equal(windowBeyondTonight(MON0, MON0 - H24 + 1), false, '1 ms inside 24 h');
  assert.equal(windowBeyondTonight(MON0, SAT), true, 'Saturday 21:30 for Monday 00:00: 26.5 h');
  assert.equal(windowBeyondTonight(MON0, phx(2026, 11, 15, 21, 30)), false, 'Sunday 21:30 for Monday 00:00: 2.5 h');
  assert.equal(windowBeyondTonight(Number.NaN, SAT), false);
  assert.equal(windowBeyondTonight(MON0, Number.NaN), false);
  // An instant or a clock that is not finite is never far (the namer would throw on it, and the evening job with it).
  assert.equal(windowBeyondTonight(Number.POSITIVE_INFINITY, SAT), false);
  assert.equal(windowBeyondTonight(MON0, Number.NEGATIVE_INFINITY), false);
  // The same instant as the window entities and the cancel deadline change their wording.
  assert.equal(fmtSiteDayHm(MON0, MON0 - H24), 'Mon 00:00');
  assert.equal(fmtSiteDayHm(MON0, MON0 - H24 + 1), '00:00');
});

test('★★★ FW-2 the window\'s words: named from the moment the text is written, null inside 24 h and with no window', () => {
  assert.deepEqual(farWindowWords({ startMs: MON0, endMs: MON5 }, SAT), { when: 'Monday 12am–5am', opens: 'Monday at 12:00 AM' });
  // The Sunday before a Monday holiday: Tuesday's window.
  assert.deepEqual(farWindowWords({ startMs: phx(2027, 1, 19, 0), endMs: phx(2027, 1, 19, 5) }, phx(2027, 1, 17, 21, 30)), { when: 'Tuesday 12am–5am', opens: 'Tuesday at 12:00 AM' });
  // A window on the next date, a day or more out: "tomorrow", by its open — never by its close (Monday).
  assert.deepEqual(farWindowWords({ startMs: phx(2026, 11, 15, 22), endMs: phx(2026, 11, 16, 4) }, SAT), { when: 'tomorrow 10pm–4am', opens: 'tomorrow at 10:00 PM' });
  assert.equal(farWindowWords({ startMs: MON0, endMs: MON5 }, phx(2026, 11, 15, 21, 30)), null, 'Sunday evening: tonight');
  assert.equal(farWindowWords({ startMs: MON0, endMs: MON5 }, MON0 - H24 + 1), null);
  assert.notEqual(farWindowWords({ startMs: MON0, endMs: MON5 }, MON0 - H24), null);
  assert.equal(farWindowWords(null, SAT), null);
  assert.equal(farWindowWords(undefined, SAT), null);
  assert.equal(farWindowWords({ startMs: Number.NaN, endMs: MON5 }, SAT), null);
  assert.equal(farWindowWords({ startMs: MON0, endMs: Number.NaN }, SAT), null);
  assert.equal(farWindowWords({ startMs: MON0, endMs: MON5 }, Number.NaN), null);
  assert.equal(farWindowWords({ startMs: Number.POSITIVE_INFINITY, endMs: MON5 }, SAT), null);
  assert.equal(farWindowWords({ startMs: MON0, endMs: Number.POSITIVE_INFINITY }, SAT), null);
  assert.equal(farWindowWords({ startMs: MON0, endMs: MON5 }, Number.NEGATIVE_INFINITY), null);
});

test('★★★ FW-3 the 21:30 push of a window a day or more out, shape by shape, word for word — and the evenings beside it unmoved', () => {
  const cases = farTextCases();
  assert.deepEqual(GOLDEN.cases.map((g) => g.name), cases.map((c) => c.name));
  assert.equal(cases.filter((c) => c.kind === 'far').length, 24);
  assert.equal(cases.filter((c) => c.kind === 'near').length, 8);
  cases.forEach((c, i) => {
    const g = GOLDEN.cases[i];
    assert.equal(isFar(c.plan), c.kind === 'far', `${c.name}: its window is ${c.kind}`);
    assert.equal(c.shape, g.shape, `${c.name}: the shape the fixture reaches`);
    const m = buildNightChargeMessage(c.plan, c.shape, c.supervised, c.armRefused, c.mode);
    assert.equal(m.title, g.push.title, `${c.name}: title`);
    assert.equal(m.body, g.push.body, `${c.name}: body`);
    // The route the evening job takes, and the spoken notice: it named the window's day already, and does not move.
    const a = eveningAnnouncement({ cycle: 'overnight', plan: c.plan, shape: c.shape, supervised: c.supervised, armRefused: c.armRefused, mode: c.mode });
    assert.deepEqual({ title: a.push.title, body: a.push.body }, g.push, `${c.name}: routed push`);
    assert.deepEqual(a.spoken, g.spoken, `${c.name}: speech`);
    if (c.kind === 'far') {
      // `was` is v1.205.1's render of this case (captured at 8f4b6748). It is held to the code, not to the file: the same plan made
      // 2.5 h before its window, with the same arm, refusal and mode, renders it word for word — but for the weekday on a force-charge
      // start ("~Mon 01:39" / "~01:39"), the one thing v1.205.1 read the plan's clock for. And the far words differ from it.
      const near = buildNightChargeMessage({ ...c.plan, generatedAt: c.plan.window!.startMs - 2.5 * H } as NightChargePlan, c.shape, c.supervised, c.armRefused, c.mode);
      assert.equal(near.title, g.was!.title, `${c.name}: inside 24 h the title is v1.205.1's`);
      assert.equal(near.body, g.was!.body.replace(/~(?:Mon|Tue) (\d\d:\d\d)/g, '~$1'), `${c.name}: inside 24 h the body is v1.205.1's`);
      assert.notEqual(m.title, near.title, `${c.name}: the far title differs from the same plan's inside 24 h`);
      assert.notEqual(m.body, near.body, `${c.name}: the far body differs from the same plan's inside 24 h`);
    }
  });
  // The shapes the far golden is meant to reach, from its own words.
  const far = GOLDEN.cases.filter((g) => g.kind === 'far').map((g) => g.push);
  for (const re of [
    /^Night-charge: charging to ~32% Monday 12am–5am \(~11\.1 kWh\)$/, /^Night-charge: charging toward ~95% Monday 12am–5am \(~72 kWh\)$/,
    /^Night-charge: reserve held at 37% Monday 12am–5am — no charge expected$/, /^Night-charge: charge to ~32% recommended for Monday 12am–5am \(~11\.1 kWh\)$/,
    /^Night-charge: reserve hold at 37% recommended for Monday 12am–5am — no charge expected$/, /^Night-charge: planned charge for Monday 12am–5am NOT armed$/,
    /^Night-charge: planned reserve hold for Monday 12am–5am NOT armed$/, /^Night-charge: no plan for Monday 12am–5am$/,
    /^Night-charge: hold for Monday 12am–5am \(the need is under the minimum buy\)$/, /^Night-charge: no charge Monday 12am–5am \(the window cannot cover the cushion\)$/,
    /^Night-charge: hold for Monday 12am–5am \(no charge needed\)$/, /^Night-charge: charging to ~34% Monday 12am–5am \(~16\.9 kWh\) — outage cushion only$/,
    /^Night-charge: charging toward ~95% Tuesday 12am–5am \(~74\.7 kWh\)$/,
  ]) assert.ok(far.some((p) => re.test(p.title)), `no far case reaches ${re}`);
  for (const s of [
    'No charge is planned for tonight: the charge window opens Monday at 12:00 AM. Charging the backup pool to ~32% in that window, ~11.1 kWh of grid energy expected. ',
    'the low SoC after that window ~0% without this charge; with it ~22.1%; the floor+cushion line is 30.5%. ',
    'the low SoC after that window ~0% with or without this charge; the floor+cushion line is 23.5%. ',
    'the low SoC after that window ~0% without this write; with it ~31.3%; the floor+cushion line is 35.5%. ',
    "for that window's 52.2% outage line (above the 50% the panel holds as a reserve)",
    ' NOTE: the buy exceeds the PV headroom of the morning after that window; a small clip is accepted to hold resilience.',
    'if the car charges in that window the packs will receive less than planned.',
    "Nothing is armed for that window. NOTE: nothing is armed to hold that window's 30.5% floor+cushion line — residual risk remains.",
    'No charge is planned for tonight: the charge window opens Tuesday at 12:00 AM. ',
    'so nothing is armed for it. (This confirms the evening job ran; the reserve floor is unchanged.)',
  ]) assert.ok(far.some((p) => p.body.includes(s)), `no far case says: ${s}`);
  // No far push names a day beside its island lows: the sentence says "after that window", and reads no instant but the window's.
  for (const p of far) assert.doesNotMatch(p.body, /with it ~[\d.]+%, |full buy ~[\d.]+%, |, on (?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day;/, p.body);

  // The cases the year reaches rarely or never, each written out here against the named case's own render.
  const pushOf = (name: string): { title: string; body: string } => {
    const c = cases.find((x) => x.name === name);
    assert.ok(c != null, `no case named ${name}`);
    return buildNightChargeMessage(c.plan, c.shape, c.supervised, c.armRefused, c.mode);
  };
  // The three sized holds, whole.
  assert.equal(pushOf('Sat for Mon: hold, under the minimum buy').body,
    'No charge is planned for the Monday 12am–5am window — the islanded worst case the plan is sized on needs only a small top-up, under the minimum buy, so nothing is armed for it.');
  assert.equal(pushOf('Sat for Mon: hold, the window cannot cover the cushion').body,
    'No charge is planned for the Monday 12am–5am window — the outage cushion needs a charge, but this window cannot deliver enough to clear the minimum buy, so nothing is armed for it.'
    + ' NOTE: charge/pool limits prevent fully meeting the cushion — residual risk remains.'
    + ' NOTE: no EVSE prediction covers this window, so EV contention is NOT modelled — if the car charges in that window the packs will receive less than planned.');
  assert.equal(pushOf('Sat for Mon: hold, the cushion holds (2026-10-24, a full pool)').body,
    'No charge is needed in the Monday 12am–5am window — even if the grid were lost from now on, the pack would close the charge window at ~55.5%, at or above the 23.4% floor+cushion line. Nothing is armed for it.');
  // …and on the legacy cushion basis, where the figure is the whole-house low.
  const legacy = pushOf('Sat for Mon: hold, the cushion holds on the legacy basis (2026-10-24, no islanded load)');
  assert.equal(legacy.title, 'Night-charge: hold for Monday 12am–5am (no charge needed)');
  assert.equal(legacy.body,
    'No charge is needed in the Monday 12am–5am window — even if the grid were lost from now on, the whole-house low would stay at ~31.8%, at or above the 25% floor+cushion line. Nothing is armed for it.');
  // A reserve that reads above the write (51%): no write is due, so no charge is priced — never "without this charge".
  const above = pushOf('Sat for Mon: the reserve reads above the write, the lows differ (2026-10-17, 51%, 10 h)');
  assert.ok(above.body.includes("the low SoC after that window ~0% with no charge; with the plan's full buy ~64%; the floor+cushion line is 87.2%. "), above.body);
  const aboveSame = pushOf('Sat for Mon: the reserve reads above the write, the lows the same (2027-05-01, 51%, 6 h)');
  assert.ok(aboveSame.body.includes("the low SoC after that window ~0% with no charge or with the plan's full buy; the floor+cushion line is 60.2%. "), aboveSame.body);
  for (const m of [above, aboveSame]) {
    assert.doesNotMatch(m.body, /without this charge|this write|with it ~|with or without/, m.body);
    assert.ok(m.body.endsWith("Cancel from the night-charge card on the panel before the window opens. The figures above are this evening's; a later evening run that arms the same window replaces this arm."), m.body);
  }
  // A night that stands at 50%: "this charge" even with nothing expected (no write is due to name), its standing tail, then the close.
  const stands = pushOf('Sat for Mon: a night that stands at 50%, its line force-charge armed (2026-10-17, 10 h)');
  const standsHeld = pushOf('Sat for Mon: a night that stands at 50%, nothing expected (expected buy stamped 0)');
  assert.equal(standsHeld.title, 'Night-charge: reserve held at 50% Monday 12am–5am — no charge expected');
  for (const m of [stands, standsHeld]) {
    assert.ok(m.body.includes('the low SoC after that window ~0% without this charge; with it ~64%; the floor+cushion line is 86.2%. '), m.body);
    assert.doesNotMatch(m.body, /this write|tonight's write/, m.body);
    assert.ok(m.body.includes("for that window's 86.2% outage line (above the 50% the panel holds as a reserve)"), m.body);
    assert.ok(m.body.endsWith("that reading is restored after the window. Cancel from the night-charge card on the panel. The figures above are this evening's; a later evening run that arms the same window replaces this arm."), m.body);
  }
  // No expected figure: the title states none, and the body's headline ends at the window.
  const noFigure = pushOf('Sat for Mon: charge with no expected figure (no median load)');
  assert.equal(noFigure.title, 'Night-charge: charging to ~32% Monday 12am–5am');
  assert.ok(noFigure.body.startsWith('No charge is planned for tonight: the charge window opens Monday at 12:00 AM. Charging the backup pool to ~32% in that window. Whole-house island projection'), noFigure.body);
  assert.doesNotMatch(`${noFigure.title} ${noFigure.body}`, /kWh|—/, noFigure.body);
});

/**
 * The far plans of the fixture year, every input a literal written here:
 *  - the 21:30 plans at 4-20 h on both pools, the line gate on and off, and the dark year (every far plan a charge, a reserve hold or
 *    an incomplete basis: the fixture's own evenings reach no sized hold);
 *  - and, on each far evening, the variants that reach the rest (v1.206.0 review): the pool at 15, 25, 40, 60, 80 and 100%, on both
 *    objectives, at the default minimum buy and at 40 kWh (holds under the minimum buy; holds whose cushion holds); a starved window
 *    (a 0.2 kW charge cap, a 5 kWh minimum buy, a 20% pool), lit and dark (the window cannot cover the cushion; its caps and EV
 *    notes); the legacy cushion basis (no islanded load) at 40-100% (the whole-house hold); and a panel reserve read at 50% and at
 *    51% under a line at 8 and 12 h (a night that stands; a reserve above the write, which prices no charge).
 */
function* farYear(): Generator<{ where: string; p: NightChargePlan; gate: boolean; set: 'year' | 'variant' }> {
  const CASES = legacyIdentityCases();
  type Deps = (typeof CASES)[number]['deps'];
  const live = (d: Deps): Deps => ({ ...d, forceChargeEligible: d.objectiveMode === 'cost' && (d.costMaxSocPct ?? 90) > 50 } as Deps);
  const planOf = (d: Deps): NightChargePlan => computeNightChargePlan(buildNightChargeInputs(d));
  for (const c of CASES.filter((x) => / 21:30$/.test(x.label))) {
    for (const b of ['np', 'm'] as const) for (let h = 4; h <= 20; h++) for (const gate of [true, false]) {
      const p = planOf({ ...live(c.deps), outageCushionHours: h, ...(b === 'm' ? { cushionPoolScale: MEASURED_SCALE } : {}), lineForceChargeEligible: gate } as Deps);
      if (isFar(p)) yield { where: `${c.label} ${b} ${h} h gate ${gate}`, p, gate, set: 'year' };
    }
    const dark = planOf(darkDeps(c.deps, 'held'));
    if (isFar(dark)) yield { where: `${c.label} dark`, p: dark, gate: true, set: 'year' };
    if (!isFar(planOf(c.deps))) continue;
    const variants: Array<[string, Deps]> = [];
    for (const socNowPct of [15, 25, 40, 60, 80, 100]) for (const objectiveMode of ['resilience', 'cost'] as const) for (const minBuyKwh of [null, 40]) {
      variants.push([`pool ${socNowPct}% ${objectiveMode}${minBuyKwh == null ? '' : ` min buy ${minBuyKwh}`}`, live({ ...c.deps, socNowPct, objectiveMode, ...(minBuyKwh == null ? {} : { minBuyKwh }) } as Deps)]);
    }
    const starved = { ...c.deps, chargeCapKw: 0.2, gridInputCapKw: 0.2, minBuyKwh: 5, socNowPct: 20 } as Deps;
    variants.push(['starved', starved], ['starved, dark', darkDeps(starved, 'held')]);
    for (const socNowPct of [40, 60, 80, 100]) variants.push([`legacy basis, pool ${socNowPct}%`, { ...c.deps, socNowPct, islandedLoadKw: null, objectiveMode: 'resilience', forceChargeEligible: false } as Deps]);
    for (const reserveFloorPct of [50, 51]) for (const outageCushionHours of [8, 12]) {
      variants.push([`reserve reads ${reserveFloorPct}%, ${outageCushionHours} h`, { ...c.deps, reserveFloorPct, outageCushionHours, lineForceChargeEligible: true } as Deps]);
    }
    for (const [name, d] of variants) {
      const p = planOf(d);
      assert.equal(isFar(p), true, `${c.label} ${name}: a far evening's variant is far`);
      yield { where: `${c.label} ${name}`, p, gate: true, set: 'variant' };
    }
  }
}
/** The sweep, planned once for the tests that walk it (the plans are read, never written). */
let FAR_YEAR: Array<{ where: string; p: NightChargePlan; gate: boolean; set: 'year' | 'variant' }> | null = null;
const farYearPlans = (): NonNullable<typeof FAR_YEAR> => (FAR_YEAR ??= [...farYear()]);
const WHY = "a prior night's reserve write is unresolved";
const renders = (p: NightChargePlan, gate: boolean): Array<{ v: 'armed' | 'advisory' | 'refused'; title: string; body: string }> => {
  const shape = !p.basisComplete ? 'insufficient_basis' as const : p.chargeTonight ? 'charge' as const : 'hold' as const;
  const line = gate && p.forceChargeLine != null ? { askPct: p.forceChargeLine.askPct, linePct: p.forceChargeLine.linePct, panelCeilingPct: 80 } : null;
  const sup = { targetPct: 50, cancelDeadlineText: 'on Monday at 12:00 AM', forceChargeTargetPct: line != null ? null : p.costCeilingSocPct ?? null, forceChargeLine: line };
  const out: ReturnType<typeof renders> = [];
  if (shape === 'charge') out.push({ v: 'armed', ...buildNightChargeMessage(p, shape, sup, null, 'supervised') });
  out.push({ v: 'advisory', ...buildNightChargeMessage(p, shape, null, null, 'advisory') });
  if (shape === 'charge') out.push({ v: 'refused', ...buildNightChargeMessage(p, shape, null, WHY, 'supervised') });
  return out;
};
/** The window's name, from the calendar (UTC−7, no DST: the fixture's zone), never from the subject. */
const whenOf = (p: NightChargePlan): string => `${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][new Date(p.window!.startMs - 7 * H).getUTCDay()]} 12am–5am`;
const ESTIMATE = " The figures above are this evening's; a later evening run that arms the same window replaces this arm.";
/** The four phrases a note or the supervised tail changes in a far push, written out here (FW-6 holds the subject's to them). */
const MAP: Array<[string, string]> = [
  ["tonight's ", "that window's "],
  ['Resilience needs no buy tonight', 'Resilience needs no buy in that window'],
  ['tomorrow morning’s PV headroom', 'the PV headroom of the morning after that window'],
  ['if the car charges overnight', 'if the car charges in that window'],
];
const mapped = (s: string): string => MAP.reduce((t, [a, b]) => t.split(a).join(b), s);
/** A push body's NOTE sentences. Each ends where the next begins, or at the supervised or advisory tail, or at a basis sentence (a
 *  hold's notes come before its provisional-band, cushion-only and panel-basis sentences), or at the end. */
const NOTE_END = "(?= NOTE: | SUPERVISED: | Advisory only | PROVISIONAL SOLAR BAND: | Outage cushion only; no solar basis \\(| No solar basis \\(| Solar from the panel's readings| Panel solar not used|$)";
const notes = (body: string): string[] => (body.match(new RegExp(` NOTE: .*?${NOTE_END}`, 'g')) ?? []);

/** A sized hold of a far window, by kind — decided here from the plan's own figures (as the 21:30 job's hold shape is). */
type HoldKind = 'underMinBuy' | 'cannotCover' | 'cushionHoldsPack' | 'cushionHoldsWholeHouse';
const holdKindOf = (p: NightChargePlan): HoldKind => (p.cushionShortfall ? 'cannotCover' : (p.requiredExtraKwh ?? 0) > 0 ? 'underMinBuy'
  : p.cushionBasis === 'legacy-pct' || p.cushionTroughSocPct == null ? 'cushionHoldsWholeHouse' : 'cushionHoldsPack');
/** The lead of each far hold, written out: the three literal patterns (the third in its two figures), each closing on what is armed. */
const FAR_HOLD_LEAD: Record<HoldKind, (when: string) => RegExp> = {
  underMinBuy: (when) => new RegExp(`^No charge is planned for the ${when} window — the islanded worst case the plan is sized on needs only a small top-up, under the minimum buy, so nothing is armed for it\\.`),
  cannotCover: (when) => new RegExp(`^No charge is planned for the ${when} window — the outage cushion needs a charge, but this window cannot deliver enough to clear the minimum buy, so nothing is armed for it\\.`),
  cushionHoldsPack: (when) => new RegExp(`^No charge is needed in the ${when} window — even if the grid were lost from now on, the pack would close the charge window at ~[\\d.]+%, at or above the [\\d.]+% floor\\+cushion line\\. Nothing is armed for it\\.`),
  cushionHoldsWholeHouse: (when) => new RegExp(`^No charge is needed in the ${when} window — even if the grid were lost from now on, the whole-house low would stay at ~[\\d.]+%, at or above the [\\d.]+% floor\\+cushion line\\. Nothing is armed for it\\.`),
};
const FAR_HOLD_TITLE: Record<HoldKind, (when: string) => string> = {
  underMinBuy: (when) => `Night-charge: hold for ${when} (the need is under the minimum buy)`,
  cannotCover: (when) => `Night-charge: no charge ${when} (the window cannot cover the cushion)`,
  cushionHoldsPack: (when) => `Night-charge: hold for ${when} (no charge needed)`,
  cushionHoldsWholeHouse: (when) => `Night-charge: hold for ${when} (no charge needed)`,
};
/** The same hold inside 24 h, as v1.205.1 words it: what follows this lead there is what may follow the far lead (its notes in that
 *  window's words; its provisional-band and basis sentences as they are). */
const NEAR_HOLD_LEAD: Record<HoldKind, RegExp> = {
  underMinBuy: /^No overnight charge tonight — the islanded worst case the plan is sized on needs only a small top-up, under the minimum buy, so nothing will be charged\./,
  cannotCover: /^No overnight charge tonight — the outage cushion needs a charge, but this window cannot deliver enough to clear the minimum buy, so nothing will be charged\./,
  cushionHoldsPack: /^No overnight charge needed — even if the grid were lost overnight, the pack would close the charge window at ~[\d.]+%, at or above the [\d.]+% floor\+cushion line\. Nothing will be charged\./,
  cushionHoldsWholeHouse: /^No overnight charge needed — even if the grid were lost overnight, the whole-house low would stay at ~[\d.]+%, at or above the [\d.]+% floor\+cushion line\. Nothing will be charged\./,
};

/** The far plans of the sweep and their pushes by kind, as measured on the change. Which plan is which kind is the planner's doing
 *  (unchanged by v1.206.0); what each push must say is in the rules below, not in these counts.
 *   - year: the fixture's own far evenings reach no sized hold (holds 0), which is why the variants exist;
 *   - variants: 34 on each of the 52 far evenings (1,768 plans), 359 of them sized holds, by kind in `holds`;
 *   - holdRendersWithANote: every hold whose window cannot cover the cushion carries its caps note (and its EV note where unmodelled);
 *   - lows: how the island lows are said — one figure or two, and the two forms of a reserve read above the write. */
const PIN_FAR = {
  year: { plans: 3588, armed: 3308, advisory: 3308, refused: 3308, noPlan: 280, holds: 0 },
  variants: { plans: 1768, armed: 1269, advisory: 1269, refused: 1269, noPlan: 140, holds: 359 },
  holds: { underMinBuy: 177, cannotCover: 142, cushionHoldsPack: 31, cushionHoldsWholeHouse: 9 },
  holdRendersWithANote: 142,
  lows: { same: 1378, differ: 7520, fullBuySame: 8, fullBuyDiffer: 160 },
};

test('★★★ FW-4 the year\'s far pushes: every one names its window, none says tonight, overnight or tomorrow of it, a charge leads with "No charge is planned for tonight", an armed one closes with the later-arm rule, a hold is one of three literal patterns that close on what is armed, and none promises what a later evening run decides; counted', () => {
  const zero = (): typeof PIN_FAR.year => ({ plans: 0, armed: 0, advisory: 0, refused: 0, noPlan: 0, holds: 0 });
  const n = { year: zero(), variants: zero(), holds: { underMinBuy: 0, cannotCover: 0, cushionHoldsPack: 0, cushionHoldsWholeHouse: 0 }, holdRendersWithANote: 0, lows: { same: 0, differ: 0, fullBuySame: 0, fullBuyDiffer: 0 } };
  const errs: string[] = [];
  for (const { where, p, gate, set } of farYearPlans()) {
    const c = set === 'year' ? n.year : n.variants;
    c.plans += 1;
    const when = whenOf(p);
    const day = when.split(' ')[0];
    const charge = p.basisComplete && p.chargeTonight;
    const hold = p.basisComplete && !p.chargeTonight;
    for (const r of renders(p, gate)) {
      const at = `${where} ${r.v}`;
      const t = `${r.title}\n${r.body}`;
      if (!p.basisComplete) c.noPlan += 1; else if (hold) c.holds += 1; else c[r.v] += 1;
      if (!r.title.includes(when)) errs.push(`${at}: the title does not name ${when}: ${r.title}`);
      // The only "tonight" left is the lead's, and the advisory contract's entity key.
      const rest = t.replace(`No charge is planned for tonight: the charge window opens ${day} at 12:00 AM. `, '').replace('(charge_tonight)', '');
      if (/\b(tonight|overnight|tomorrow)\b/i.test(rest) || rest.includes('tomorrow’s')) errs.push(`${at}: ${/[^.]*\b(?:tonight|overnight|tomorrow)\b[^.]*/i.exec(rest)?.[0]}`);
      if (/will be charged|will not charge|will not raise/.test(t)) errs.push(`${at}: a promise past this evening: ${t}`);
      if (/undefined|NaN/.test(t)) errs.push(`${at}: ${t}`);
      const lead = `No charge is planned for tonight: the charge window opens ${day} at 12:00 AM. `;
      if (charge && r.v !== 'refused' && !r.body.startsWith(lead)) errs.push(`${at}: no lead: ${r.body}`);
      if ((!charge || r.v === 'refused') && r.body.includes('No charge is planned for tonight')) errs.push(`${at}: the lead on a push with nothing armed or recommended: ${r.body}`);
      if (r.v === 'armed' && !r.body.endsWith(ESTIMATE)) errs.push(`${at}: an armed far push without the later-arm rule: ${r.body}`);
      if (r.v !== 'armed' && /a later evening run|this arm\b|this evening's/.test(r.body)) errs.push(`${at}: the later-arm rule with nothing armed: ${r.body}`);
      if (r.v === 'refused' && !r.body.includes('. Nothing is armed for that window.')) errs.push(`${at}: ${r.body}`);
      if (!p.basisComplete && !r.body.endsWith('so nothing is armed for it. (This confirms the evening job ran; the reserve floor is unchanged.)')) errs.push(`${at}: ${r.body}`);
      // A sized hold: its title, one of the three literal leads, and after the lead only what the same hold carries inside 24 h —
      // its notes in that window's words, then its provisional-band and basis sentences untouched.
      if (hold) {
        const kind = holdKindOf(p);
        n.holds[kind] += 1;
        if (r.title !== FAR_HOLD_TITLE[kind](when)) errs.push(`${at}: the ${kind} hold's title: ${r.title}`);
        const farLead = FAR_HOLD_LEAD[kind](when).exec(r.body)?.[0];
        const nearBody = buildNightChargeMessage({ ...p, generatedAt: p.window!.startMs - 2.5 * H } as NightChargePlan, 'hold', null, null, 'advisory').body;
        const nearLead = NEAR_HOLD_LEAD[kind].exec(nearBody)?.[0];
        if (farLead == null || nearLead == null) { errs.push(`${at}: not the ${kind} hold's words: ${r.body} | inside 24 h: ${nearBody}`); continue; }
        const tail = r.body.slice(farLead.length);
        const nearTail = nearBody.slice(nearLead.length);
        const nearNotes = notes(nearTail).join('');
        if (!nearTail.startsWith(nearNotes)) errs.push(`${at}: a hold's notes do not come first inside 24 h: ${nearBody}`);
        if (tail !== mapped(nearNotes) + nearTail.slice(nearNotes.length)) errs.push(`${at}: after the lead: ${tail} | inside 24 h: ${nearTail}`);
        if (kind !== 'cannotCover' && nearNotes !== '') errs.push(`${at}: a note on a hold that carries none: ${r.body}`);
        if (nearNotes !== '') n.holdRendersWithANote += 1;
        continue;
      }
      // The island lows: said once where they are the same figure; a reserve above the write prices no charge.
      const atTarget = p.cushionEnvelopeReason === 'reserveAtTarget';
      const lows = [
        /the low SoC after that window ~[\d.]+% with or without this (?:charge|write); the floor\+cushion line is /.test(r.body),
        /the low SoC after that window ~[\d.]+% without this (?:charge|write); with it ~[\d.]+%; the floor\+cushion line is /.test(r.body),
        /the low SoC after that window ~[\d.]+% with no charge or with the plan's full buy; the floor\+cushion line is /.test(r.body),
        /the low SoC after that window ~[\d.]+% with no charge; with the plan's full buy ~[\d.]+%; the floor\+cushion line is /.test(r.body),
      ];
      if (lows[0]) n.lows.same += 1;
      if (lows[1]) n.lows.differ += 1;
      if (lows[2]) n.lows.fullBuySame += 1;
      if (lows[3]) n.lows.fullBuyDiffer += 1;
      const projected = r.body.includes('Whole-house island projection');
      if (lows.filter(Boolean).length !== (projected ? 1 : 0)) errs.push(`${at}: not one statement of the island lows: ${r.body}`);
      if (projected && atTarget !== (lows[2] || lows[3])) errs.push(`${at}: a reserve above the write prices no charge, and only it: ${r.body}`);
      if (atTarget && /without this charge|this write|with it ~/.test(r.body)) errs.push(`${at}: a charge priced on a night no write is due: ${r.body}`);
      // The two island lows said twice when they are the same figure: never.
      const two = /~([\d.]+)% (?:without this (?:charge|write); with it|with no charge; with the plan's full buy) ~([\d.]+)%/.exec(r.body);
      if (two != null && two[1] === two[2]) errs.push(`${at}: the same low said twice: ${two[0]}`);
    }
  }
  assert.deepEqual(errs.slice(0, 5), [], `${errs.length} errors`);
  assert.deepEqual(n, PIN_FAR);
});

test('★★★ FW-5 a far push carries exactly the notes its plan carries inside 24 h, in that window\'s words: none added, none dropped — the starved hold\'s too', () => {
  // The same plan made 2.5 h before its window (only the clock the words are written at differs): its NOTE sentences, with the four
  // phrases mapped here by hand (MAP), are the far push's.
  let plans = 0, withNotes = 0, holdsWithNotes = 0;
  const errs: string[] = [];
  for (const { where, p, gate } of farYearPlans()) {
    plans += 1;
    const near = { ...p, generatedAt: p.window!.startMs - 2.5 * H } as NightChargePlan;
    assert.equal(isFar(near), false);
    const f = renders(p, gate);
    const nr = renders(near, gate);
    f.forEach((r, i) => {
      const want = notes(nr[i].body).map(mapped);
      const got = notes(r.body);
      if (want.length > 0) withNotes += 1;
      if (want.length > 0 && p.basisComplete && !p.chargeTonight) holdsWithNotes += 1;
      if (JSON.stringify(got) !== JSON.stringify(want)) errs.push(`${where} ${r.v}: ${JSON.stringify(got)} != ${JSON.stringify(want)}`);
    });
  }
  assert.deepEqual(errs.slice(0, 3), [], `${errs.length} errors`);
  assert.equal(plans, PIN_FAR.year.plans + PIN_FAR.variants.plans);
  assert.ok(withNotes > 5000, `${withNotes} renders with a note`);
  assert.equal(holdsWithNotes, PIN_FAR.holdRendersWithANote, 'the holds that carry a note (the starved window\'s caps and EV notes)');
});

test('★★★ FW-6 farNoteWords maps the builder\'s four phrases and nothing else', () => {
  assert.equal(farNoteWords(" NOTE: tonight's 59.4% outage line is above the 50% the panel accepts as a reserve, and nothing is armed to carry it — residual risk remains."),
    " NOTE: that window's 59.4% outage line is above the 50% the panel accepts as a reserve, and nothing is armed to carry it — residual risk remains.");
  assert.equal(farNoteWords(' Resilience needs no buy tonight — the pack already covers the outage cushion; this buy is economic (cost mode).'),
    ' Resilience needs no buy in that window — the pack already covers the outage cushion; this buy is economic (cost mode).');
  assert.equal(farNoteWords(' NOTE: the buy exceeds tomorrow morning’s PV headroom; a small clip is accepted to hold resilience.'),
    ' NOTE: the buy exceeds the PV headroom of the morning after that window; a small clip is accepted to hold resilience.');
  assert.equal(farNoteWords(' NOTE: no EVSE prediction covers this window, so EV contention is NOT modelled — if the car charges overnight the packs will receive less than planned.'),
    ' NOTE: no EVSE prediction covers this window, so EV contention is NOT modelled — if the car charges in that window the packs will receive less than planned.');
  const same = ' NOTE: charge/pool limits prevent fully meeting the cushion — residual risk remains. SUPERVISED: on Monday at 12:00 AM the add-on raises the backup reserve to 50% (bounded write; auto-restores after the charge window closes).';
  assert.equal(farNoteWords(same), same);
  assert.equal(farNoteWords(''), '');
});

test('★★★ FW-7 a refusal reason and a basis sentence pass through a far push untouched, whatever they say', () => {
  const c = farTextCases().find((x) => x.name === 'Sat for Mon: the Cores dark, cushion only, refused')!;
  const why = "tonight's write was cancelled, and tomorrow morning’s PV headroom is unknown";
  const m = buildNightChargeMessage(c.plan, 'charge', null, why, 'supervised');
  assert.ok(m.body.includes(`but the supervised write was not armed — ${why}. Nothing is armed for that window.`), m.body);
  const refusedBy = "tonight's band is refused";
  const q = { ...c.plan, cushionOnly: { ...c.plan.cushionOnly!, refusedBy } } as NightChargePlan;
  assert.ok(buildNightChargeMessage(q, 'charge', null, WHY, 'supervised').body.includes(` Outage cushion only; no solar basis (${refusedBy}).`));
  assert.ok(buildNightChargeMessage(q, 'charge', { cancelDeadlineText: 'on Monday at 12:00 AM', targetPct: 34 }, null, 'supervised').body.includes(`Outage cushion only; no solar basis (${refusedBy}): `));
  // A sized hold too: the starved window with the Cores dark carries its notes, then its basis sentence, and only the notes are reworded.
  const sat = legacyIdentityCases().find((x) => x.label === '2026-10-17 21:30')!;
  const starved = computeNightChargePlan(buildNightChargeInputs(darkDeps({ ...sat.deps, chargeCapKw: 0.2, gridInputCapKw: 0.2, minBuyKwh: 5, socNowPct: 20 }, 'held')));
  assert.deepEqual([isFar(starved), starved.basisComplete, starved.chargeTonight, starved.cushionShortfall, starved.cushionOnly != null], [true, true, false, true, true]);
  const hold = buildNightChargeMessage({ ...starved, cushionOnly: { ...starved.cushionOnly!, refusedBy } } as NightChargePlan, 'hold', null, null, 'supervised');
  assert.equal(hold.body, 'No charge is planned for the Monday 12am–5am window — the outage cushion needs a charge, but this window cannot deliver enough to clear the minimum buy, so nothing is armed for it.'
    + ' NOTE: charge/pool limits prevent fully meeting the cushion — residual risk remains.'
    + ' NOTE: no EVSE prediction covers this window, so EV contention is NOT modelled — if the car charges in that window the packs will receive less than planned.'
    + ` Outage cushion only; no solar basis (${refusedBy}).`);
});

test('★★★ FW-8 far is read from the plan\'s own clock (generatedAt), never the wall clock: the same plan made 2.5 h before its window reads "tonight"', () => {
  const c = farTextCases()[0];
  assert.ok(c.plan.generatedAt < Date.UTC(2026, 10, 1), 'a fixture night in the past: a wall-clock read would call it near');
  const near = { ...c.plan, generatedAt: c.plan.window!.startMs - 2.5 * H } as NightChargePlan;
  const sup = { ...c.supervised!, cancelDeadlineText: 'at 12:00 AM' };
  const m = buildNightChargeMessage(near, 'charge', sup, null, 'supervised');
  assert.equal(m.title, 'Night-charge: charging to ~32% tonight (~11.1 kWh)');
  assert.ok(m.body.startsWith('Charging the backup pool to ~32% overnight, ~11.1 kWh of grid energy expected. Whole-house island projection (if the grid were lost): tomorrow’s low SoC ~0% without this charge, ~22.1% with it; '), m.body);
  assert.ok(m.body.endsWith('Cancel from the night-charge card on the panel before then.'), m.body);
  // Exactly 24 h is far; 1 ms inside is tonight.
  assert.equal(buildNightChargeMessage({ ...c.plan, generatedAt: c.plan.window!.startMs - H24 } as NightChargePlan, 'charge', c.supervised, null, 'supervised').title, 'Night-charge: charging to ~32% tomorrow 12am–5am (~11.1 kWh)');
  assert.equal(buildNightChargeMessage({ ...c.plan, generatedAt: c.plan.window!.startMs - H24 + 1 } as NightChargePlan, 'charge', c.supervised, null, 'supervised').title, 'Night-charge: charging to ~32% tonight (~11.1 kWh)');
  // No plan, and a plan with no window: as they were.
  assert.equal(buildNightChargeMessage(null, 'insufficient_basis').title, 'Night-charge: no plan tonight');
  assert.equal(buildNightChargeMessage({ ...c.plan, window: null } as NightChargePlan, 'charge', c.supervised, null, 'supervised').title, 'Night-charge: charging to ~32% tonight (~11.1 kWh)');
});

test('★★★ FW-8b a far push made late is still far: the same Saturday planned at the 22:30 last resort and at 22:59 (25 h 01 m before the window); and it reads no instant but the window\'s and the plan\'s own clock', () => {
  const sat = legacyIdentityCases().find((x) => x.label === '2026-10-17 21:30')!;
  const first = farTextCases()[0];
  for (const [minutesLate, outMs] of [[60, 25.5 * H], [89, 25 * H + 60_000]] as const) {
    // The planner's own output at that clock (the evening job's catch-up window runs to 23:00).
    const p = computeNightChargePlan(buildNightChargeInputs({ ...sat.deps, nowMs: sat.deps.nowMs + minutesLate * 60_000 }));
    assert.equal(p.generatedAt, first.plan.generatedAt + minutesLate * 60_000);
    assert.equal(p.window!.startMs - p.generatedAt, outMs, `${minutesLate} min late`);
    assert.deepEqual([p.basisComplete, p.chargeTonight], [true, true]);
    const m = buildNightChargeMessage(p, 'charge', first.supervised, null, 'supervised');
    assert.equal(m.title, 'Night-charge: charging to ~32% Monday 12am–5am (~11.1 kWh)', `${minutesLate} min late`);
    assert.ok(m.body.startsWith('No charge is planned for tonight: the charge window opens Monday at 12:00 AM. Charging the backup pool to ~32% in that window, '), m.body);
    assert.ok(m.body.endsWith(`Cancel from the night-charge card on the panel before then.${ESTIMATE}`), m.body);
    assert.doesNotMatch(m.body.replace('No charge is planned for tonight: ', ''), /\b(tonight|overnight|tomorrow)\b/i, m.body);
  }
  // The island lows name no day, so the instant of the with-charge low is not read: missing, not a number, infinite or days out, the
  // push is the same, word for word, and never throws (a throw here would cost that evening's arm).
  const want = buildNightChargeMessage(first.plan, 'charge', first.supervised, null, 'supervised');
  for (const ts of [null, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, first.plan.window!.endMs + 26 * H]) {
    assert.deepEqual(buildNightChargeMessage({ ...first.plan, minProjSocTsMs: ts } as NightChargePlan, 'charge', first.supervised, null, 'supervised'), want, String(ts));
  }
});

/* ── the card ── */

const Z = 'America/Phoenix';
const wd = (ms: number): string | null => fmtWeekdayHHMMIn(ms, Z);

test('★★★ FW-9 the card: a window a day or more out is shown with its weekday, a line says no charge is planned for tonight, and its Cancel is not "tonight"; inside 24 h the card reads as it did', () => {
  assert.equal(fmtWeekdayHHMMIn(MON0, Z), 'Mon 00:00');
  assert.equal(fmtWeekdayHHMMIn(MON5, Z), 'Mon 05:00');
  // The weekday is the site zone's: Sunday 20:00 in Phoenix is Monday 03:00 UTC.
  assert.equal(fmtWeekdayHHMMIn(phx(2026, 11, 15, 20), Z), 'Sun 20:00');
  assert.equal(fmtWeekdayHHMMIn(phx(2026, 11, 15, 20), 'Europe/Berlin'), 'Mon 04:00', 'the same instant, a zone on the other side of midnight');
  assert.equal(fmtWeekdayHHMMIn(MON0, 'Europe/Berlin'), 'Mon 08:00');
  assert.equal(fmtWeekdayHHMMIn(MON0, undefined), null);
  assert.equal(fmtWeekdayHHMMIn(null, Z), null);
  assert.equal(fmtWeekdayHHMMIn(MON0, 'Not/AZone'), null);
  assert.equal(beyondTonight(MON0, MON0 - H24), true);
  assert.equal(beyondTonight(MON0, MON0 - H24 + 1), false);
  assert.equal(beyondTonight(null, SAT), false);
  assert.equal(beyondTonight(undefined, SAT), false);
  assert.equal(beyondTonight(MON0, Number.NaN), false);
  assert.equal(beyondTonight(MON0, SAT), true, 'Saturday 21:30 for Monday 00:00: 26.5 h');
  assert.equal(beyondTonight(MON0, phx(2026, 11, 15, 21, 30)), false, 'Sunday 21:30 for Monday 00:00: 2.5 h');
  // The card's far window: when it opens, in the weekday clock (the card writes the span itself, from the same clock: FW-10).
  assert.deepEqual(card.farCardWindow({ startMs: MON0, endMs: MON5 }, SAT, wd), { opens: 'Mon 00:00' });
  assert.equal(card.farCardWindow({ startMs: MON0, endMs: MON5 }, phx(2026, 11, 15, 21, 30), wd), null, 'Sunday evening: tonight');
  assert.notEqual(card.farCardWindow({ startMs: MON0, endMs: MON5 }, MON0 - H24, wd), null);
  assert.equal(card.farCardWindow({ startMs: MON0, endMs: MON5 }, MON0 - H24 + 1, wd), null);
  assert.equal(card.farCardWindow(null, SAT, wd), null);
  assert.equal(card.farCardWindow({ startMs: MON0, endMs: null }, SAT, wd), null);
  assert.equal(card.farCardWindow({ startMs: MON0, endMs: MON5 }, SAT, () => null), null, 'no site zone: no clock, no far words');
  assert.equal(card.farCardWindow({ startMs: MON0, endMs: Number.NaN }, SAT, wd), null);
  assert.equal(card.farCardWindow({ startMs: MON0, endMs: MON5 }, Number.NaN, wd), null);
  assert.equal(card.farLeadText({ opens: 'Mon 00:00' }), 'No charge is planned for tonight — the charge window opens Mon 00:00.');
  // The banner.
  const armed = { day: '2026-11-14', appliedAtMs: null, revertedAtMs: null, cancelled: false, windowEndMs: MON5, cancelDeadlineMs: MON0, targetPct: 50, priorReservePct: null };
  assert.deepEqual(card.actuationBannerState(armed, wd(MON0), 16, true), { text: 'Supervised write armed — reserve → 50% at Mon 00:00.', settled: false, cancel: 'Cancel this write' });
  assert.deepEqual(card.actuationBannerState(armed, wd(MON0), 50, true), { text: 'Supervised write armed for Mon 00:00 — the reserve reads 50%, so none is due while it does.', settled: false, cancel: 'Cancel this write' });
  assert.deepEqual(card.actuationBannerState({ ...armed, cancelled: true }, wd(MON0), 16, true), { text: 'Cancelled — the armed write is withdrawn.', settled: true, cancel: null });
  // Inside 24 h, and by default: the words as they were.
  assert.deepEqual(card.actuationBannerState(armed, fmtHHMMIn(MON0, Z), 16, false), { text: 'Supervised write armed — reserve → 50% at 00:00.', settled: false, cancel: 'Cancel tonight' });
  assert.deepEqual(card.actuationBannerState(armed, fmtHHMMIn(MON0, Z), 16), { text: 'Supervised write armed — reserve → 50% at 00:00.', settled: false, cancel: 'Cancel tonight' });
  assert.deepEqual(card.actuationBannerState({ ...armed, cancelled: true }, null, 16), { text: 'Cancelled — no write tonight.', settled: true, cancel: null });
  // A state with its own Cancel keeps it.
  assert.equal(card.actuationBannerState({ ...armed, appliedAtMs: MON0, priorReservePct: 16 }, null, 50, true).cancel, 'Cancel & revert');
  assert.deepEqual(card.farBannerState({ text: 'Completed — reserve restored to 16%.', settled: true, cancel: null }), { text: 'Completed — reserve restored to 16%.', settled: true, cancel: null });
});

test('★★ FW-10 [source pins: the card component cannot be imported here] the card passes the weekday clock and the far flag where a window is a day or more out', () => {
  const src = readFileSync(new URL('../../web/src/cards/NightChargeCard.tsx', import.meta.url), 'utf8');
  assert.ok(src.includes('  const weekdayHm: ClockFmt = (ms) => fmtWeekdayHHMMIn(ms, status.siteTimeZone);\n'));
  assert.ok(src.includes('  const far = farCardWindow(plan.window, Date.now(), weekdayHm);\n'));
  assert.ok(src.includes('  const ws = far != null ? weekdayHm(plan.window?.startMs) : hhmm(plan.window?.startMs);\n'));
  assert.ok(src.includes('  const we = far != null ? weekdayHm(plan.window?.endMs) : hhmm(plan.window?.endMs);\n'));
  assert.ok(src.includes('      {far != null && !refused && !closedLead && (\n        <div className="text-xs text-muted mb-3 -mt-2">{farLeadText(far)}</div>\n      )}\n'));
  assert.ok(src.includes('spacing={spacing} weekdayHm={weekdayHm} hhmm={hhmm} reservePct={status.reserveFloorPercent} />'));
  const banner = src.slice(src.indexOf('function ActuationBanner('), src.indexOf('function StatusBlindCancel('));
  assert.ok(banner.includes('  const far = beyondTonight(actuation.windowStartMs, Date.now());\n'));
  assert.ok(banner.includes('  const state = actuationBannerState(actuation, (far ? weekdayHm : hhmm)(actuation.cancelDeadlineMs), reservePct, far);\n'));
});
