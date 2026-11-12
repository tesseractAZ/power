import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  computeNightChargePlan, buildNightChargeInputs, floorCushionLinePct, noChargeExpected, type NightChargePlan,
} from '../src/nightChargeAdvisor.js';
import { buildNightChargeMessage } from '../src/notify.js';
import { buildMiddayPlanMessage, middaySpokenNotice, refusedCushionLineNote } from '../src/chargeText.js';
import {
  summariseLeg, coerceMiddayShadowRecord, middayShadowAnnounceInput, middayShadowPreview, type MiddayShadowRecord, type ShadowLegSummary,
} from '../src/middayShadow.js';
import { buildApsREvModel } from '../src/tariff.js';
import { legacyIdentityCases } from './fixtures/legacyIdentityFixtures.js';
import { MEASURED_SCALE } from './fixtures/measuredCushionLineFigures.js';
import { darkDeps } from './fixtures/cushionOnlyFigures.js';

/**
 * ★★★ v1.205.1 — A REFUSED NIGHT WITH NO LINE FORCE-CHARGE.
 *
 * A refused arm arms nothing (index.ts: armCycle's refusal; the 21:30 push says "The add-on will not charge tonight"). v1.205.0 gave
 * a refused night whose plan carries a line force-charge one note: nothing is armed to carry its line (refusedEnvelopeNote). A
 * refused night with NO line force-charge whose cushion still asked for energy (requiredExtraKwh above 0) said nothing of it: the
 * fixture year's 21:30 plans at 4-20 h on both pools, 3,711 charge-shape and 1,128 hold-shape pushes per write mode, carried no note
 * or only the caps note (2026-10-13 21:30 on nameplate, 4 h: 15.19 kWh asked, a 31.3% line, "The add-on will not charge tonight."
 * and nothing more). Each now says once that nothing is armed to hold its floor+cushion line, named as its armed push names the line
 * ("the floor+cushion line is 31.3%"), after the caps note where the sizing fell short; the mid-day refused push says it of the leg
 * ("this leg's"), through the leg's record (ShadowLegSummary.cushionAskedLinePct, optional: a record from before it reads as before).
 * A plan whose envelope note fires keeps that note only (AO-15b); a plan whose cushion asked for nothing, and every armed render,
 * are unchanged.
 */

const CASES = legacyIdentityCases();
const live = (d: Record<string, unknown>) => ({ ...d, forceChargeEligible: d.objectiveMode === 'cost' && ((d.costMaxSocPct as number | undefined) ?? 90) > 50 });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type P = NightChargePlan & Record<string, any>;
const planAt = (label: string, b: 'np' | 'm', h: number, extra: Record<string, unknown> = {}): P => computeNightChargePlan({
  ...buildNightChargeInputs({
    ...live(CASES.find((c) => c.label === label)!.deps as unknown as Record<string, unknown>), outageCushionHours: h,
    ...(b === 'm' ? { cushionPoolScale: MEASURED_SCALE } : {}), lineForceChargeEligible: true, ...extra,
  } as never)!,
} as never) as P;
/** Every 21:30 plan of the fixture year at 4-20 h on both pools (AO-14, AO-15's sweep). */
function* year(): Generator<{ where: string; p: P }> {
  for (const c of CASES.filter((x) => / 21:30$/.test(x.label))) for (const b of ['np', 'm'] as const) for (let h = 4; h <= 20; h++) {
    yield { where: `${c.label} ${b} ${h} h`, p: planAt(c.label, b, h) };
  }
}

type WriteMode = 'supervised' | 'auto';
const WHY = 'the panel reports the grid is not connected';
const SUP = { targetPct: 50, cancelDeadlineText: 'Until 11:00 PM', forceChargeTargetPct: null };
const refusedOf = (p: P, mode: WriteMode = 'supervised') => buildNightChargeMessage(p, 'charge', null, WHY, mode);
const CAPS_NOTE = ' NOTE: charge/pool limits prevent fully meeting the cushion — residual risk remains.';
const tonight = (l: string): string => ` NOTE: nothing is armed to hold tonight's ${l}% floor+cushion line — residual risk remains.`;
const thisLeg = (l: string): string => ` NOTE: nothing is armed to hold this leg's ${l}% floor+cushion line — residual risk remains.`;
const ANY_UNHELD = /nothing is armed to hold (?:tonight's|this leg's)/g;
const UNHELD = /nothing is armed to hold (?:tonight's|this leg's)/;
/** The plan's sizing fell short (the caps note): refused or armed, its pushes say it. */
const sizingShortOf = (p: P): boolean => p.cushionShortfall === true && p.cushionShortfallCause !== 'envelope';
/** The cushion asked for energy. */
const asked = (p: P): boolean => p.requiredExtraKwh != null && p.requiredExtraKwh > 0;

/** The mid-day route (lineAtOpenAllowance.test.ts middayRoute): the leg's record (summariseLeg) across a restore
 *  (coerceMiddayShadowRecord), in the record's write mode, refused in the probe's words where `refused`. */
const MODEL = buildApsREvModel();
const phx = (mo: number, d: number, h: number, mi = 0): number => Date.UTC(2026, mo - 1, d, h + 7, mi);
const MIDDAY_WHY = "a prior night's reserve write is unresolved";
const COST_LEG = { role: 'cost', kind: 'super_off_peak', startMs: phx(10, 15, 10), endMs: phx(10, 15, 15) } as const;
const recordOf = (p: P, mode: 'supervised' | 'auto' | 'advisory', refused: boolean, backup: ShadowLegSummary | null = null): MiddayShadowRecord => ({
  version: 1, day: '2026-10-14', computedAtMs: phx(10, 14, 21, 30), why: 'midday', mode, backup,
  cost: summariseLeg(COST_LEG, { plan: p, windowPvP50Kwh: null, windowLoadP50Kwh: null },
    refused ? { wouldArm: false, disposition: `would not arm — ${MIDDAY_WHY}` }
      : mode === 'advisory' ? { wouldArm: false, disposition: 'not armed — the night-charge mode is advisory' } : { wouldArm: true, disposition: 'would arm' }),
  refresh: null, note: null,
});
const restored = (r: MiddayShadowRecord): MiddayShadowRecord => coerceMiddayShadowRecord(JSON.parse(JSON.stringify(r)))!;
const inputOf = (p: P, mode: 'supervised' | 'auto' | 'advisory' = 'supervised', refused = false) => middayShadowAnnounceInput(restored(recordOf(p, mode, refused)), MODEL)!;

/** The 2026-10-13 21:30 night on nameplate, 4 h: the finding. */
const FINDING = () => planAt('2026-10-13 21:30', 'np', 4);

test('★★★ RN-1 the finding, word for word: 2026-10-13 21:30 on nameplate, 4 h (15.19 kWh asked, a 31.3% line, no line force-charge) — the refused 21:30 push says once that nothing is armed to hold tonight\'s 31.3% floor+cushion line, as its armed push names the line; both write modes, both shapes', () => {
  const p = FINDING();
  assert.deepEqual([p.requiredExtraKwh, p.cushionLineSocPct, floorCushionLinePct(p), p.reserveFloorPct, p.forceChargeLine ?? null, p.cushionShortfall, p.cushionShortfallCause ?? null, noChargeExpected(p)],
    [15.19, 31.3, 31.3, 16, null, false, null, false]);
  // The armed push names the line so: "the floor+cushion line is 31.3%".
  assert.match(buildNightChargeMessage(p, 'charge', SUP as never).body, /; the floor\+cushion line is 31\.3%\. /);
  const m = refusedOf(p);
  assert.equal(m.title, 'Night-charge: planned charge NOT armed tonight');
  assert.equal(m.body, "Tonight's plan calls for a charge, but the supervised write was not armed — the panel reports the grid is not connected. "
    + "The add-on will not charge tonight. NOTE: nothing is armed to hold tonight's 31.3% floor+cushion line — residual risk remains.");
  assert.equal(refusedOf(p, 'auto').body, "Tonight's plan calls for a charge, but the write was not armed — the panel reports the grid is not connected. "
    + "The add-on will not charge tonight. NOTE: nothing is armed to hold tonight's 31.3% floor+cushion line — residual risk remains.");
  // The reserve-hold shape ("will not raise the reserve tonight"): the same note.
  const held = refusedOf({ ...p, expectedBuyKwh: 0 } as P, 'auto');
  assert.equal(held.title, 'Night-charge: planned reserve hold NOT armed tonight');
  assert.equal(held.body, "Tonight's plan holds the backup reserve at 36% overnight as a floor, with no charge expected, but the write was not armed — "
    + "the panel reports the grid is not connected. The add-on will not raise the reserve tonight. NOTE: nothing is armed to hold tonight's 31.3% floor+cushion line — residual risk remains.");
  // The mid-day refused push on the same plan, through the leg's record: "this leg's".
  const mid = buildMiddayPlanMessage(inputOf(p, 'supervised', true));
  assert.equal(mid.title, "Charge plan: tomorrow's 10am–3pm charge NOT armed");
  assert.equal(mid.body, `The plan for tomorrow 10am–3pm calls for a charge, but the supervised write was not armed — ${MIDDAY_WHY}. `
    + "The add-on will not charge tomorrow. NOTE: nothing is armed to hold this leg's 31.3% floor+cushion line — residual risk remains.");
  assert.equal(buildMiddayPlanMessage(inputOf({ ...p, expectedBuyKwh: 0 } as P, 'auto', true)).body,
    `The plan for tomorrow 10am–3pm calls for a reserve hold, but the write was not armed — ${MIDDAY_WHY}. `
    + "The add-on will not charge tomorrow. NOTE: nothing is armed to hold this leg's 31.3% floor+cushion line — residual risk remains.");
  // The helper: one decimal as the armed push states the line; unnumbered with no figure.
  assert.equal(refusedCushionLineNote("tonight's", 48.99), tonight('49'));
  assert.equal(refusedCushionLineNote("this leg's", null), " NOTE: nothing is armed to hold this leg's floor+cushion line — residual risk remains.");
  assert.equal(refusedCushionLineNote("tonight's", Number.NaN), " NOTE: nothing is armed to hold tonight's floor+cushion line — residual risk remains.");
});

/** RN-2 — the year, counted on the landed change: the refused non-line plans whose cushion asked for energy, by shape and write mode
 *  (each count the same overnight and mid-day), and of them the ones whose sizing fell short (the caps note first). */
const PIN_RN2 = {
  supervised: { charge: 3711, hold: 1128, chargeCaps: 999, holdCaps: 136 },
  auto: { charge: 3711, hold: 1128, chargeCaps: 999, holdCaps: 136 },
};
/** …the refused plans with no new note: a line force-charge (AO-15's 4,094, per mode), and a cushion that asked for nothing. */
const PIN_RN2_UNCHANGED = { line: 4094, notAsked: 727 };
/** Every armed render of every swept plan — the 21:30 push supervised and advisory, the mid-day push and spoken notice in each write
 *  mode, armed — hashed: captured at 8e8c13f4 (v1.205.0) and unchanged. */
const PIN_ARMED = { renders: 62050, sha256: '6c55e88ec6f8824d65b02c5ba3c6c50be0f7b403552af5f00ba26bf923d517cf' };

test('★★★ RN-2 the year at 21:30, 4-20 h, both pools: every refused plan with no line force-charge whose cushion asked for energy says once that nothing is armed to hold its floor+cushion line — overnight and mid-day, both write modes, charge and hold shapes, the caps note first — named as its armed push names the line; every armed render byte-identical; counted', () => {
  const count = { supervised: { charge: 0, hold: 0, chargeCaps: 0, holdCaps: 0 }, auto: { charge: 0, hold: 0, chargeCaps: 0, holdCaps: 0 } };
  const unchanged = { line: 0, notAsked: 0 };
  const armed = createHash('sha256');
  let renders = 0;
  const errs: string[] = [];
  for (const { where, p } of year()) {
    // The armed renders (refused unset): the 21:30 push supervised and advisory, the mid-day push and speech armed in each mode.
    for (const m of [buildNightChargeMessage(p, p.chargeTonight ? 'charge' : 'hold', SUP as never), buildNightChargeMessage(p, p.chargeTonight ? 'charge' : 'hold', null)]) {
      armed.update(`${m.title}\n${m.body}\n`);
      renders++;
      if (UNHELD.test(m.body)) errs.push(`${where}: an armed 21:30 push says nothing is armed: ${m.body}`);
    }
    for (const mode of ['supervised', 'auto', 'advisory'] as const) {
      const i = inputOf(p, mode);
      const m = buildMiddayPlanMessage(i);
      armed.update(`${m.title}\n${m.body}\n`);
      armed.update(`${JSON.stringify(middaySpokenNotice(i))}\n`);
      renders++;
      if (UNHELD.test(m.body)) errs.push(`${where} ${mode}: an armed mid-day push says nothing is armed: ${m.body}`);
    }
    if (!p.chargeTonight) continue; // a hold is never refused (index.ts: the arm is tried on a charge plan only)
    const line = floorCushionLinePct(p);
    const named = /the floor\+cushion line is ([\d.]+)%/.exec(buildNightChargeMessage(p, 'charge', SUP as never).body)?.[1];
    for (const mode of ['supervised', 'auto'] as const) {
      const body = refusedOf(p, mode).body;
      const mid = buildMiddayPlanMessage(inputOf(p, mode, true)).body;
      if (p.forceChargeLine != null || !asked(p)) {
        if (mode === 'supervised') unchanged[p.forceChargeLine != null ? 'line' : 'notAsked'] += 1;
        if ((body + mid).match(ANY_UNHELD) != null) errs.push(`${where} ${mode}: the note on a plan it is not for: ${body} | ${mid}`);
        continue;
      }
      const shape = noChargeExpected(p) ? 'hold' : 'charge';
      count[mode][shape] += 1;
      const short = sizingShortOf(p);
      if (short) count[mode][`${shape}Caps`] += 1;
      const lead = shape === 'hold' ? 'The add-on will not raise the reserve tonight.' : 'The add-on will not charge tonight.';
      // Named as the armed push names it (its own rounding: a 48.99% line is "49%" there and here).
      if (named == null || named !== String(Math.round(line! * 10) / 10)) errs.push(`${where}: the armed push names ${named}, the line is ${line}`);
      if (!body.endsWith(`${lead}${short ? CAPS_NOTE : ''}${tonight(named ?? '?')}`)) errs.push(`${where} ${mode}: ${body}`);
      if (body.match(ANY_UNHELD)?.length !== 1 || body.split(' NOTE: ').length !== (short ? 3 : 2)) errs.push(`${where} ${mode}: not one note per fact: ${body}`);
      if (!mid.endsWith(`The add-on will not charge tomorrow.${short ? CAPS_NOTE : ''}${thisLeg(named ?? '?')}`)) errs.push(`${where} ${mode} mid-day: ${mid}`);
      if (mid.match(ANY_UNHELD)?.length !== 1) errs.push(`${where} ${mode} mid-day: not one note: ${mid}`);
    }
  }
  assert.deepEqual(errs.slice(0, 5), [], `${errs.length} errors`);
  assert.deepEqual(count, PIN_RN2);
  assert.deepEqual(unchanged, PIN_RN2_UNCHANGED);
  assert.deepEqual({ renders, sha256: armed.digest('hex') }, PIN_ARMED, 'every armed render byte-identical to v1.205.0');
});

test('★★★ RN-3 only where the cushion asked for energy and no other line note fires: a plan whose cushion asked for nothing is unchanged, a plan with an envelope note keeps that note only (AO-15b), a line force-charge keeps its refused note (AO-15)', () => {
  const p = FINDING();
  for (const req of [0, null]) {
    const q = { ...p, requiredExtraKwh: req } as P;
    assert.equal(refusedOf(q).body, "Tonight's plan calls for a charge, but the supervised write was not armed — the panel reports the grid is not connected. The add-on will not charge tonight.", String(req));
    const mid = buildMiddayPlanMessage(inputOf(q, 'supervised', true)).body;
    assert.ok(mid.endsWith('The add-on will not charge tomorrow.'), `${req}: ${mid}`);
    assert.equal('cushionAskedLinePct' in recordOf(q, 'supervised', true).cost!, false, `${req}: no line asked for on the record`);
  }
  // An envelope note (a recompute of a window armed with no line ask, 2027-04-09 21:30 at ×0.944, 7 h): that note only.
  const late = planAt('2027-04-09 21:30', 'm', 7);
  const noLine = planAt('2027-04-09 21:30', 'm', 7, { armedNoLineStartMs: late.window!.startMs });
  assert.deepEqual([noLine.forceChargeLine ?? null, noLine.cushionShortfallCause, noLine.cushionEnvelopeReason, asked(noLine)], [null, 'envelope', 'armedNoLine', true]);
  for (const mode of ['supervised', 'auto'] as const) {
    const b = refusedOf({ ...noLine, expectedBuyKwh: 7.2 } as P, mode).body;
    assert.ok(b.endsWith("The add-on will not charge tonight. NOTE: tonight's 59.4% outage line is above the 50% the panel accepts as a reserve, and no force-charge carries it to the window close — residual risk remains."), b);
    assert.equal(b.match(ANY_UNHELD), null, b);
  }
  // A line force-charge: its refused note, never this one.
  assert.equal(refusedOf(late).body.match(ANY_UNHELD), null);
  assert.match(refusedOf(late).body, /nothing is armed to carry it — residual risk remains\.$/);
  // Mid-day: a cost leg disclosing its own envelope (no force-charge carries it on this leg) keeps that note only.
  const disclosing = buildMiddayPlanMessage({ ...inputOf(p, 'supervised', true), cost: { ...inputOf(p, 'supervised', true).cost, cushionShortfallCause: 'envelope' } }).body;
  assert.ok(disclosing.endsWith('NOTE: the outage line is above the 50% the panel accepts as a reserve and no force-charge carries it on this leg — residual risk remains.'), disclosing);
  assert.equal(disclosing.match(ANY_UNHELD), null, disclosing);
  // (review, T2) …and so does one whose envelope comes with the caps ('envelope+caps'): the caps note, then the leg's own envelope
  // note, and nothing else — every cause excludes the unheld-line note, not 'envelope' alone.
  const i = inputOf(p, 'supervised', true);
  const both = buildMiddayPlanMessage({ ...i, cost: { ...i.cost, cushionShortfall: true, cushionShortfallCause: 'envelope+caps' } }).body;
  assert.ok(both.endsWith(`The add-on will not charge tomorrow.${CAPS_NOTE} NOTE: the outage line is above the 50% the panel accepts as a reserve and no force-charge carries it on this leg — residual risk remains.`), both);
  assert.equal(both.match(ANY_UNHELD), null, both);
});

test('★★ RN-4 mid-day: the leg\'s note comes before the backup leg\'s (as an armed leg\'s does), after the caps note; never on a cycle that arms, advisory included', () => {
  const p = FINDING();
  const i = inputOf(p, 'supervised', true);
  const backup = { windowStartMs: phx(10, 14, 23), windowEndMs: phx(10, 15, 5), reservePct: 50, expectedKwh: 12.4, buyKwh: 20.1, cushionShortfall: true, cushionShortfallCause: 'envelope' as const };
  const two = buildMiddayPlanMessage({ ...i, backup }).body;
  assert.ok(two.endsWith(`, and there is no outage backup tonight because ${MIDDAY_WHY}.${thisLeg('31.3')} NOTE: the outage line is above the 50% the panel accepts as a reserve and no force-charge carries it on the backup leg — residual risk remains.`), two);
  const capped = buildMiddayPlanMessage({ ...i, cost: { ...i.cost, cushionShortfall: true } }).body;
  assert.ok(capped.endsWith(`The add-on will not charge tomorrow.${CAPS_NOTE}${thisLeg('31.3')}`), capped);
  // Armed, advisory: the leg's record carries the line, and no push says it.
  for (const mode of ['supervised', 'auto', 'advisory'] as const) {
    const a = inputOf(p, mode);
    assert.equal(a.refused, null, mode);
    assert.equal(a.cost.cushionAskedLinePct, 31.3, mode);
    assert.equal(buildMiddayPlanMessage(a).body.match(ANY_UNHELD), null, mode);
    assert.equal(buildMiddayPlanMessage({ ...a, backup }).body.match(ANY_UNHELD), null, mode);
  }
});

test('★★★ RN-5 the record: summariseLeg carries the floor+cushion line the leg\'s cushion asked for, the file round-trips it, and a record from before v1.205.1 (none) renders the refused push as before', () => {
  const p = FINDING();
  const rec = recordOf(p, 'supervised', true);
  assert.equal(rec.cost!.cushionAskedLinePct, 31.3);
  assert.deepEqual(restored(rec), rec);
  // A v1.205.0 record: no field — coerced, and the refused push names no line.
  const old = JSON.parse(JSON.stringify(rec));
  delete old.cost.cushionAskedLinePct;
  const back = coerceMiddayShadowRecord(old)!;
  assert.equal('cushionAskedLinePct' in back.cost!, false);
  assert.equal(middayShadowPreview(back, MODEL)!.push.body, `The plan for tomorrow 10am–3pm calls for a charge, but the supervised write was not armed — ${MIDDAY_WHY}. The add-on will not charge tomorrow.`);
  // A malformed figure is dropped, never named.
  for (const bad of ['31.3', null, Number.NaN, {}]) {
    const r = JSON.parse(JSON.stringify(rec));
    r.cost.cushionAskedLinePct = bad;
    assert.equal('cushionAskedLinePct' in coerceMiddayShadowRecord(r)!.cost!, false, String(bad));
  }
  assert.ok(middayShadowPreview(restored(rec), MODEL)!.push.body.endsWith(thisLeg('31.3')));
});

/* ── v1.205.1 (item 2) — the mid-day "no force-charge carries it" note, worded by the named leg's own line ─────────────────────── */

const OVER_RESERVE = 'the 50% the panel accepts as a reserve';
const OVER_HELD = 'the 49% the panel holds the pool at under the 50% it accepts as a reserve';
const notCarried = (which: 'this leg' | 'the backup leg', over: string): string =>
  ` NOTE: the outage line is above ${over} and no force-charge carries it on ${which} — residual risk remains.`;
const BACKUP_LEG = { role: 'backup', kind: 'overnight', startMs: phx(10, 14, 23), endMs: phx(10, 15, 5) } as const;
/** An armed mid-day input (the finding's cost leg, no line ask) with a backup leg that discloses its own line. */
const withBackup = (linePct: number | undefined, mode: 'supervised' | 'auto' | 'advisory' = 'supervised', refused = false) => {
  const i = inputOf(FINDING(), mode, refused);
  return buildMiddayPlanMessage({
    ...i, backup: { windowStartMs: phx(10, 14, 23), windowEndMs: phx(10, 15, 5), reservePct: 50, expectedKwh: 12.4, buyKwh: 20.1,
      cushionShortfall: true, cushionShortfallCause: 'envelope', ...(linePct !== undefined ? { linePct } : {}) },
    backupApplyAtMs: phx(10, 14, 23),
  }).body;
};

/** The supervised mid-day push of 2026-11-27 21:30 at ×0.944, 16 h (the armed line ask, a 49.99% line) beside a backup leg with an
 *  envelope cause and no line figure, as v1.205.0 (8e8c13f4) renders it. */
const V1205_EDGE_BACKUP_BODY = 'Tomorrow (Thu) 10am–3pm, APS super off-peak: charging the backup pool toward ~50%, as far as the window can deliver, about '
  + '7 kWh of grid energy expected. The plan is refreshed with the morning solar forecast at 9:30 AM; it can only lower or cancel this charge. '
  + 'SUPERVISED: at 10:00 AM the backup reserve is held at 50% and Charge Now switches on just in time; both are restored at 3:00 PM, before '
  + 'the 4–7pm on-peak. Cancel from the charge card before 10:00 AM tomorrow. Tonight 11pm–5am, outage backup: reserve held at 50%, about '
  + "12 kWh expected. NOTE: on the median load this leg's pool is expected to close too close to its outage line to allow for a late "
  + 'switch-on at the window open — residual risk remains. NOTE: the outage line is above the 50% the panel accepts as a reserve and no '
  + 'force-charge carries it on the backup leg — residual risk remains. Sizing basis (the islanded worst case the plan is sized on, not the '
  + 'expected charge): ~7 kWh for the daytime charge, ~20.1 kWh for the outage backup.';

test('★★★ RN-6 the backup leg\'s note is worded by its own line, as the overnight envelope note is: a line at or below 50 is above the 49% the panel holds the pool at (49.00%, 49.99%, 50.00%), never the 50% it accepts; above 50 (50.01%, 59.4%) and with no figure (a record from before it), v1.205.0\'s words byte for byte — beside a cost leg that carries a line of its own too', () => {
  for (const mode of ['supervised', 'auto', 'advisory'] as const) {
    const old = withBackup(undefined, mode);
    assert.ok(old.includes(notCarried('the backup leg', OVER_RESERVE)), `${mode}: ${old}`);
    for (const l of [50.01, 59.43, 92.34]) assert.equal(withBackup(l, mode), old, `${mode} ${l}: byte for byte`);
    // (review, T5) 49.00 too: lineOverReserveText words every line at or below 50 so, as the overnight push of 2027-08-31 21:30 at
    // ×0.944, 7 h (a 49.00% line, no line force-charge) does.
    for (const l of [49, 49.01, 49.5, 49.99, 50]) {
      const b = withBackup(l, mode);
      // The only armed renders that change: a backup line at or below 50 (49.00-50.00 on the fixture year: refusedNotesArmedYear RN-8),
      // and only by the level it is above.
      assert.equal(b, old.replace(notCarried('the backup leg', OVER_RESERVE), notCarried('the backup leg', OVER_HELD)), `${mode} ${l}`);
    }
  }
  // Refused: the leg's note first, then the backup leg's, each worded by its own line.
  assert.ok(withBackup(49.99, 'supervised', true).endsWith(`${thisLeg('31.3')}${notCarried('the backup leg', OVER_HELD)}`));
  assert.ok(withBackup(59.43, 'auto', true).endsWith(`${thisLeg('31.3')}${notCarried('the backup leg', OVER_RESERVE)}`));
  // Beside an ARMED cost leg with a line ask (A5-xxxii's shape): the backup leg's note, worded by its line.
  const late = planAt('2027-04-09 21:30', 'm', 7);
  const armedLine = inputOf(late);
  const backup = { windowStartMs: phx(10, 14, 23), windowEndMs: phx(10, 15, 5), reservePct: 50, expectedKwh: 12.4, buyKwh: 20.1, cushionShortfall: true, cushionShortfallCause: 'envelope' as const };
  assert.ok(buildMiddayPlanMessage({ ...armedLine, backup: { ...backup, linePct: 49.99 } }).body.includes(notCarried('the backup leg', OVER_HELD)));
  assert.ok(buildMiddayPlanMessage({ ...armedLine, backup: { ...backup, linePct: 65.71 } }).body.includes(notCarried('the backup leg', OVER_RESERVE)));
  // (review, T4) A backup leg with no line figure (a record written by v1.205.0) beside a cost leg that carries one — the armed line
  // ask of 2026-11-27 21:30 at ×0.944, 16 h, a 49.99% line — keeps v1.205.0's words byte for byte: the backup leg's note is worded by
  // the backup leg's own line, or by none, never by the cost leg's.
  const edgeLine = planAt('2026-11-27 21:30', 'm', 16);
  for (const mode of ['supervised', 'auto', 'advisory'] as const) {
    const e = inputOf(edgeLine, mode);
    assert.deepEqual([e.cost.lineAskPct, e.cost.linePct], [51, 49.99], mode);
    const body = buildMiddayPlanMessage({ ...e, backup }).body;
    assert.ok(body.includes(notCarried('the backup leg', OVER_RESERVE)) && !body.includes(OVER_HELD), `${mode}: ${body}`);
    if (mode === 'supervised') assert.equal(body, V1205_EDGE_BACKUP_BODY, 'byte for byte with v1.205.0 (captured at 8e8c13f4)');
    // …and with the backup leg's own figure, its own words: a 59.43% line beside the cost leg's 49.99%.
    assert.ok(buildMiddayPlanMessage({ ...e, backup: { ...backup, linePct: 59.43 } }).body.includes(notCarried('the backup leg', OVER_RESERVE)), mode);
  }
});

test('★★★ RN-7 through the record: a backup leg sized on a 49.99% line (2026-11-27 21:30 at ×0.944, 16 h) carries it to the evening\'s words, and the shadow\'s log names it beside the 49% too; a cost leg with no line ask is worded by its own line', async () => {
  const { middayShadowLogLines } = await import('../src/middayShadow.js');
  const edge = planAt('2026-11-27 21:30', 'm', 16);
  const high = planAt('2027-04-09 21:30', 'm', 7);
  assert.deepEqual([edge.cushionLineSocPct, edge.cushionShortfallCause, high.cushionLineSocPct, high.cushionShortfallCause], [49.99, 'envelope', 59.43, 'envelope']);
  const recWith = (bp: P, mode: 'supervised' | 'advisory' = 'supervised'): MiddayShadowRecord => ({
    ...recordOf(FINDING(), mode, false),
    backup: summariseLeg(BACKUP_LEG, { plan: bp, windowPvP50Kwh: null, windowLoadP50Kwh: null },
      mode === 'advisory' ? { wouldArm: false, disposition: 'not armed — the night-charge mode is advisory' } : { wouldArm: true, disposition: 'would arm' }),
  });
  for (const mode of ['supervised', 'advisory'] as const) {
    const i = middayShadowAnnounceInput(restored(recWith(edge, mode)), MODEL)!;
    assert.deepEqual([i.backup?.linePct, i.backup?.cushionShortfallCause], [49.99, 'envelope'], mode);
    assert.ok(middayShadowPreview(restored(recWith(edge, mode)), MODEL)!.push.body.includes(notCarried('the backup leg', OVER_HELD)), mode);
    assert.equal(middayShadowAnnounceInput(restored(recWith(high, mode)), MODEL)!.backup?.linePct, 59.43, mode);
    assert.ok(middayShadowPreview(restored(recWith(high, mode)), MODEL)!.push.body.includes(notCarried('the backup leg', OVER_RESERVE)), mode);
  }
  // The shadow's evening log line for the backup leg: the same words.
  const logOf = (bp: P): string => middayShadowLogLines(restored(recWith(bp)))[0];
  assert.match(logOf(edge), new RegExp(`; the line is above ${OVER_HELD}, and the backup leg writes the reserve only — residual risk remains\\.`));
  assert.match(logOf(high), new RegExp(`; the line is above ${OVER_RESERVE}, and the backup leg writes the reserve only — residual risk remains\\.`));
  const plain = middayShadowAnnounceInput(restored({ ...recWith(edge), backup: { ...recWith(edge).backup!, cushionShortfallCause: undefined } }), MODEL)!;
  assert.equal(plain.backup != null && 'linePct' in plain.backup, false);
  // A leg with no envelope cause carries no line (nothing words by it).
  assert.equal('linePct' in inputOf(FINDING()).cost, false);
  // A cost leg with no line ask and an envelope cause (advisory: no force-charge runs): "this leg", worded by its own line.
  const advEdge = planAt('2026-11-27 21:30', 'm', 16, { lineForceChargeEligible: false });
  assert.deepEqual([advEdge.forceChargeLine ?? null, advEdge.cushionShortfallCause, advEdge.cushionLineSocPct], [null, 'envelope', 49.99]);
  for (const mode of ['supervised', 'advisory'] as const) {
    const ci = inputOf(advEdge, mode);
    assert.equal(ci.cost.linePct, 49.99, mode);
    assert.ok(buildMiddayPlanMessage(ci).body.includes(notCarried('this leg', OVER_HELD)), `${mode}: ${buildMiddayPlanMessage(ci).body}`);
    // Above 50: v1.205.0's words.
    const advHigh = planAt('2027-04-09 21:30', 'm', 7, { lineForceChargeEligible: false });
    assert.ok(buildMiddayPlanMessage(inputOf(advHigh, mode)).body.includes(notCarried('this leg', OVER_RESERVE)), mode);
  }
  // (review, T1) Both legs on an envelope, on different lines: the cost leg's "on this leg" note is worded by the cost leg's own line,
  // never the backup leg's — a 59.43% cost line (2027-04-09 21:30 at ×0.944, 7 h) beside a 49.99% backup line (2026-11-27 21:30 at
  // ×0.944, 16 h) is above the 50% the panel accepts; the reverse is above the 49% the panel holds. Through the record, both modes.
  const noAsk = (label: string, h: number): P => planAt(label, 'm', h, { lineForceChargeEligible: false });
  const cross = (cp: P, bp: P, mode: 'supervised' | 'advisory'): string => {
    const arm = mode === 'advisory' ? { wouldArm: false, disposition: 'not armed — the night-charge mode is advisory' } : { wouldArm: true, disposition: 'would arm' };
    const rec: MiddayShadowRecord = {
      ...recordOf(cp, mode, false), backup: summariseLeg(BACKUP_LEG, { plan: bp, windowPvP50Kwh: null, windowLoadP50Kwh: null }, arm),
    };
    const i = middayShadowAnnounceInput(restored(rec), MODEL)!;
    assert.deepEqual([i.cost.lineAskPct ?? null, i.cost.cushionShortfallCause, i.backup?.cushionShortfallCause], [null, 'envelope', 'envelope'], mode);
    return middayShadowPreview(restored(rec), MODEL)!.push.body;
  };
  for (const mode of ['supervised', 'advisory'] as const) {
    const hiCost = cross(noAsk('2027-04-09 21:30', 7), noAsk('2026-11-27 21:30', 16), mode);
    assert.ok(hiCost.includes(notCarried('this leg', OVER_RESERVE)) && !hiCost.includes(OVER_HELD), `${mode}: ${hiCost}`);
    const edgeCost = cross(noAsk('2026-11-27 21:30', 16), noAsk('2027-04-09 21:30', 7), mode);
    assert.ok(edgeCost.includes(notCarried('this leg', OVER_HELD)), `${mode}: ${edgeCost}`);
  }
});

/* ── v1.205.1 (round 3, F5) — the refused CUSHION-ONLY night: the note's name and its place ─────────────────────────────────────── */

/** The plant's live shape: the Cores dark (0 scored calibration days, a 0% band coverage, the Cores' standby), on the seeded ×0.944
 *  held ratio (cushionOnlyFigures.ts darkDeps). */
const darkAt = (label: string, o: Record<string, unknown> = {}): P => computeNightChargePlan({
  ...buildNightChargeInputs({ ...darkDeps(CASES.find((c) => c.label === label)!.deps as never, 'held'), ...o } as never)!,
} as never) as P;
const SOLAR_REFUSAL_0 = 'only 0 scored calibration day(s), need 4 (a provisional plan on a widened solar band from 4; the full band from 14)';
/** The refused push's lead, by shape and write mode. */
const leadOf = (p: P, mode: WriteMode): string => {
  const write = mode === 'auto' ? 'the write' : 'the supervised write';
  return noChargeExpected(p)
    ? `but ${write} was not armed — ${WHY}. The add-on will not raise the reserve tonight.`
    : `but ${write} was not armed — ${WHY}. The add-on will not charge tonight.`;
};
/** RN-9 — the dark year (every case of the fixture year with the Cores dark, on the held ratio, at its own 4 h): the cushion-only
 *  charge plans, refused, by the NOTEs their push carries — U the unheld floor+cushion line, C the caps note, L a line force-charge's
 *  refused note — each count the same in both write modes. */
const PIN_RN9 = { plans: 614, U: 467, CU: 65, L: 40, CL: 21, none: 21 };
/** …of them, the plans whose basis sentence carries a long gap's words after the refusal (each still before every note). */
const PIN_RN9_GAP = 71;

test('★★★ RN-9 a refused cushion-only night (the plant\'s live shape, the Cores dark): the note keeps "floor+cushion line" — the refused push\'s short basis sentence does not define "the 33.3% line" as the armed push\'s does — on the same figure; and every NOTE follows the basis sentence, the caps note first, as the armed push orders them. 2026-10-12 word for word; the dark year counted', () => {
  // 2026-10-12, the cost case, held ratio, 4 h: 26.42 kWh asked against a 33.3% line over a 16% floor, no line force-charge, a reserve
  // hold (no charge expected).
  const p = darkAt('2026-10-12 cost', { outageCushionHours: 4 });
  assert.deepEqual([p.cushionOnly?.refusedBy, p.requiredExtraKwh, floorCushionLinePct(p), p.reserveFloorPct, p.forceChargeLine ?? null, p.cushionShortfall, noChargeExpected(p)],
    [SOLAR_REFUSAL_0, 26.42, 33.26, 16, null, false, true]);
  // The armed push defines the line in its basis sentence: "the 33.3% line is the 16% reserve floor plus 4 h of islanded backup load".
  assert.ok(buildNightChargeMessage(p, 'charge', SUP as never).body.includes(`Outage cushion only; no solar basis (${SOLAR_REFUSAL_0}): the 33.3% line is the 16% reserve floor plus 4 h of islanded backup load at the window close, with no solar credited and no cost target.`));
  // Refused: the lead, the basis it was refused on, then the note — word for word, both write modes.
  assert.equal(refusedOf(p).body, "Tonight's plan holds the backup reserve at 35% overnight as a floor, with no charge expected, but the supervised write was not armed — "
    + 'the panel reports the grid is not connected. The add-on will not raise the reserve tonight. Outage cushion only; no solar basis (only 0 scored '
    + 'calibration day(s), need 4 (a provisional plan on a widened solar band from 4; the full band from 14)). NOTE: nothing is armed to hold '
    + "tonight's 33.3% floor+cushion line — residual risk remains.");
  assert.equal(refusedOf(p, 'auto').body, "Tonight's plan holds the backup reserve at 35% overnight as a floor, with no charge expected, but the write was not armed — "
    + 'the panel reports the grid is not connected. The add-on will not raise the reserve tonight. Outage cushion only; no solar basis (only 0 scored '
    + 'calibration day(s), need 4 (a provisional plan on a widened solar band from 4; the full band from 14)). NOTE: nothing is armed to hold '
    + "tonight's 33.3% floor+cushion line — residual risk remains.");
  // A night the charge rate cannot carry (2026-10-12 resilience at 18%, 1.5 kW): the armed push's basis, then its caps note; refused,
  // the basis, the caps note, then the unheld line — never a note between the lead and the basis.
  const toward = darkAt('2026-10-12 resilience', { socNowPct: 18, chargeCapKw: 1.5 });
  assert.ok(sizingShortOf(toward) && toward.forceChargeLine == null && asked(toward));
  assert.ok(buildNightChargeMessage(toward, 'charge', SUP as never).body.includes(`no solar credited and no cost target.${CAPS_NOTE} SUPERVISED: `));
  assert.equal(refusedOf(toward, 'auto').body, `Tonight's plan calls for a charge, ${leadOf(toward, 'auto')} Outage cushion only; no solar basis (${SOLAR_REFUSAL_0}).`
    + `${CAPS_NOTE}${tonight('33.3')}`);
  // The dark year: every refused cushion-only charge plan, both write modes.
  const count = { supervised: { plans: 0, U: 0, CU: 0, L: 0, CL: 0, none: 0 }, auto: { plans: 0, U: 0, CU: 0, L: 0, CL: 0, none: 0 } };
  const errs: string[] = [];
  let gapWords = 0;
  for (const c of CASES) {
    const q = darkAt(c.label);
    if (q.cushionOnly == null || !q.chargeTonight) continue;
    const armedBody = buildNightChargeMessage(q, 'charge', SUP as never).body;
    const refusedBy = q.cushionOnly.refusedBy;
    for (const mode of ['supervised', 'auto'] as const) {
      const body = refusedOf(q, mode).body;
      const lead = leadOf(q, mode);
      const at = body.indexOf(lead);
      const rest = at < 0 ? '' : body.slice(at + lead.length);
      const n = rest.indexOf(' NOTE: ');
      const basis = n < 0 ? rest : rest.slice(0, n);
      const notes = n < 0 ? '' : rest.slice(n);
      // The basis sentence straight after the lead (the 'short' form: the refusal, and a gap's words where one follows), no note in it.
      const head = ['Outage cushion only; no solar basis', 'No solar basis'].map((b) => ` ${b} (${refusedBy})`).find((h) => basis.startsWith(`${h}.`));
      if (head == null) errs.push(`${c.label} ${mode}: no basis after the lead: ${body}`);
      else if (!armedBody.includes(`${head}: `)) errs.push(`${c.label} ${mode}: not the armed push's basis: ${body}`);
      if (head != null && basis !== `${head}.`) gapWords += 1;
      // Every NOTE after it: the caps note first where the sizing fell short, then the line's.
      const short = sizingShortOf(q);
      if (short !== notes.startsWith(CAPS_NOTE)) errs.push(`${c.label} ${mode}: the caps note not first: ${body}`);
      const own = short ? notes.slice(CAPS_NOTE.length) : notes;
      const kind = own === '' ? '' : own.includes('nothing is armed to hold') ? 'U' : own.includes('nothing is armed to carry it') ? 'L' : '?';
      if (kind === '?' || own.split(' NOTE: ').length > 2) errs.push(`${c.label} ${mode}: not one line note: ${body}`);
      if (kind === 'U') {
        // Named on the armed push's figure: "the X% line is the …" there, "tonight's X% floor+cushion line" here.
        const named = /: the ([\d.]+)% line is the /.exec(armedBody)?.[1];
        if (named == null || own !== tonight(named)) errs.push(`${c.label} ${mode}: armed ${named}: ${body}`);
      }
      const k = `${short ? 'C' : ''}${kind}` || 'none';
      count[mode].plans += 1;
      if (k in count[mode]) count[mode][k as keyof typeof PIN_RN9] += 1; else errs.push(`${c.label} ${mode}: ${k}`);
    }
  }
  assert.deepEqual(errs.slice(0, 5), [], `${errs.length} errors`);
  assert.deepEqual(count, { supervised: PIN_RN9, auto: PIN_RN9 });
  assert.equal(gapWords, 2 * PIN_RN9_GAP, 'the basis carrying a gap\'s words before the notes');
});
