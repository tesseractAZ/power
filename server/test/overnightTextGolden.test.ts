import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  overnightTextCases, overnightSummaryCases, overnightRevertDeadlineCases, missedApplyCases,
} from './fixtures/overnightTextCases.js';
import {
  buildNightChargeMessage, buildNightChargeMorningSummary, buildNightChargeRevertDeadline, buildNightChargeMissedApply,
} from '../src/notify.js';
import { revertDeadlineSpoken, MAX_SPOKEN_ADVISORY_CHARS } from '../src/nightChargeActuator.js';
import { eveningAnnouncement, isMiddayLeg } from '../src/chargeAnnounce.js';
import { emptyLegState, LEGACY_LEG_FIELDS, type ChargeLegState } from '../src/chargeCycle.js';

/**
 * R5 (v1.189.0) — THE OVERNIGHT WORDS ARE BYTE-IDENTICAL (plan §5: "Overnight-only cycles keep
 * today's text byte-identical (golden test)").
 *
 * overnightTextGolden.json is what the release before the day-aware formatter said (captured at
 * d42b556, before any R5 source change) for every overnight shape in overnightTextCases.ts: the
 * 21:30 push and spoken notice (charge — force-charge riding, reserve only, toward, the cushion
 * short —, a night that charges nothing, the three holds, no plan, advisory, refused in both write
 * modes), the morning summary (every force-charge outcome, cancelled, grid lost) and the
 * revert-deadline page (both stages, read and unknown, with and without a prior and an on-peak
 * clock) — and the missed-apply push, whose clocks R5 moved onto the formatter's (backup and cost,
 * tonight, today and another day, with and without a reading). Each is checked three ways: the builders produce it; the day-aware route
 * (chargeAnnounce.eveningAnnouncement) gives an overnight cycle exactly it; and every overnight leg
 * record is routed to the overnight words (isMiddayLeg).
 */

const GOLDEN = JSON.parse(readFileSync(new URL('./fixtures/overnightTextGolden.json', import.meta.url), 'utf8')) as {
  capturedAt: string;
  evening: Array<{ name: string; push: unknown; spoken: { en: string; es: string } | null }>;
  summary: Array<{ name: string; push: unknown }>;
  revertDeadline: Array<{ name: string; push: unknown; spoken: { en: string; es: string } }>;
  missedApply: Array<{ name: string; push: unknown }>;
};

test('★★★ the golden was captured before R5 and covers every shape', () => {
  assert.equal(GOLDEN.capturedAt, 'd42b556');
  const cases = overnightTextCases();
  assert.equal(GOLDEN.evening.length, cases.length);
  assert.deepEqual(GOLDEN.evening.map((g) => g.name), cases.map((c) => c.name));
  // The shapes the fixture is meant to reach, from the golden words themselves.
  const titles = GOLDEN.evening.map((g) => (g.push as { title: string }).title);
  for (const re of [
    /^Night-charge: charging to ~80% tonight \(~34\.9 kWh\)$/, /^Night-charge: charging to ~50% tonight/, /^Night-charge: charging toward ~80% tonight/,
    /^Night-charge: charging toward ~50% tonight/, /^Night-charge: reserve held at 50% tonight — no charge expected$/,
    /^Night-charge: hold \(no charge needed\)$/, /^Night-charge: hold \(the need is under the minimum buy\)$/,
    /^Night-charge: no charge tonight \(the window cannot cover the cushion\)$/, /recommended tonight/,
    /^Night-charge: planned charge NOT armed tonight$/, /^Night-charge: planned reserve hold NOT armed tonight$/,
    /^Night-charge: no plan tonight$/,
  ]) assert.ok(titles.some((t) => re.test(t)), `no case reaches ${re}`);
  const spoken = GOLDEN.evening.filter((g) => g.spoken != null);
  assert.ok(spoken.length >= 7, `${spoken.length} spoken cases`);
  assert.ok(spoken.some((g) => g.spoken!.en.includes('toward')) && spoken.some((g) => g.spoken!.en.includes('Outage cushion not fully met.')));
  assert.ok(spoken.some((g) => g.spoken!.en.includes('no charge is expected')));
  assert.equal(GOLDEN.summary.length, overnightSummaryCases().length);
  assert.equal(GOLDEN.revertDeadline.length, overnightRevertDeadlineCases().length);
  assert.deepEqual(GOLDEN.missedApply.map((g) => g.name), missedApplyCases().map((c) => c.name));
  const missed = GOLDEN.missedApply.map((g) => (g.push as { title: string }).title);
  for (const t of ["Charge plan: tonight's outage backup did not start", "Charge plan: today's charge did not start", "Charge plan: Thursday's charge did not start"]) {
    assert.ok(missed.includes(t), `no case reaches ${t}`);
  }
});

test('★★★ the 21:30 push and spoken notice: the builders and the day-aware route give the golden words, case for case', () => {
  const cases = overnightTextCases();
  cases.forEach((c, i) => {
    const g = GOLDEN.evening[i];
    // The builders, as the evening job calls them.
    assert.deepEqual(buildNightChargeMessage(c.plan, c.shape, c.supervised, c.armRefused, c.mode), g.push, `${c.name}: push`);
    // The route an overnight cycle takes.
    const a = eveningAnnouncement({ cycle: 'overnight', plan: c.plan, shape: c.shape, supervised: c.supervised, armRefused: c.armRefused, mode: c.mode });
    assert.deepEqual(a.push, g.push, `${c.name}: routed push`);
    assert.deepEqual(a.spoken, g.spoken, `${c.name}: routed speech`);
  });
});

test('★★★ the morning summary and the revert-deadline page: the golden words', () => {
  overnightSummaryCases().forEach((c, i) => {
    assert.deepEqual(buildNightChargeMorningSummary(c.input), GOLDEN.summary[i].push, c.name);
  });
  overnightRevertDeadlineCases().forEach((c, i) => {
    const g = GOLDEN.revertDeadline[i];
    assert.deepEqual(buildNightChargeRevertDeadline(c.input), g.push, `${c.name}: push`);
    assert.deepEqual(revertDeadlineSpoken(c.input), g.spoken, `${c.name}: speech`);
  });
});

test('★★★ the revert-deadline page of a Friday window or a holiday eve names the on-peak day: the golden words with that one clause, nothing else', () => {
  // A Friday window closes at 12:00 AM Saturday and on-peak is next on Monday; the Wednesday window
  // before Thanksgiving closes at 12:00 AM Thursday and on-peak is next on Friday. Their deadline
  // page is heard at 12:30 AM: a bare "starts at 4:00 PM" reads as that afternoon. The day is named
  // (chargeText.onPeakDayWords); with no day — the page's own date — the words are the golden ones.
  for (const day of [{ en: 'on Monday', es: 'el lunes' }, { en: 'on Friday', es: 'el viernes' }]) {
    overnightRevertDeadlineCases().forEach((c, i) => {
      const g = GOLDEN.revertDeadline[i];
      assert.deepEqual(buildNightChargeRevertDeadline({ ...c.input, onPeakDay: null }), g.push, `${c.name}: no day`);
      assert.deepEqual(revertDeadlineSpoken({ ...c.input, onPeakDay: null }), g.spoken, `${c.name}: no day`);
      const push = buildNightChargeRevertDeadline({ ...c.input, onPeakDay: day }) as { title: string; body: string };
      const spoken = revertDeadlineSpoken({ ...c.input, onPeakDay: day });
      const gp = g.push as { title: string; body: string };
      if (c.input.stage === 'deadline' && c.input.onPeakClock != null) {
        assert.equal(push.body, gp.body.replace(' On-peak pricing starts at ', ` On-peak pricing starts ${day.en} at `), c.name);
        const dayed = {
          en: g.spoken.en.replace(', and on-peak pricing starts at ', `, and on-peak pricing starts ${day.en} at `),
          es: g.spoken.es.replace(', y la tarifa punta comienza a las ', `, y la tarifa punta comienza ${day.es} a las `),
        };
        // Within the spoken bound, the golden words with the day; past it (the unconfirmed page with
        // no prior), the same with what to do said compactly — the day, the reserve and the clock kept.
        const to = c.input.restorePct != null ? `${c.input.restorePct} percent` : 'its usual level';
        const toEs = c.input.restorePct != null ? `al ${c.input.restorePct} por ciento` : 'a su nivel habitual';
        const expected = dayed.en.length + dayed.es.length <= MAX_SPOKEN_ADVISORY_CHARS ? dayed : {
          en: dayed.en.replace(`Check the backup reserve in the EcoFlow app and set it to ${to}.`, `Set the backup reserve to ${to} in the EcoFlow app.`),
          es: dayed.es.replace(`Revise la reserva de respaldo en la aplicación EcoFlow y ajústela ${toEs}.`, `Ajuste la reserva de respaldo ${toEs} en la aplicación EcoFlow.`),
        };
        assert.deepEqual(spoken, expected, c.name);
        assert.ok(spoken.en.length + spoken.es.length <= MAX_SPOKEN_ADVISORY_CHARS, `${c.name}: within the bound`);
        assert.notEqual(spoken.en, g.spoken.en);
      } else {
        // The on-peak stage says it has started; with no on-peak stamp there is no clause.
        assert.deepEqual(push, gp, c.name);
        assert.deepEqual(spoken, g.spoken, c.name);
      }
      assert.equal(push.title, gp.title);
    });
  }
});

test('★★★ the revert-deadline push says the restore is retried only while one will still be sent', () => {
  // The golden page was captured with a restore still being re-sent. With none pending (a stuck
  // restore whose re-issues are spent, or one the panel cannot be read for), the push is the same
  // words with that one sentence stated as it is; the spoken page never carried it.
  const RETRYING = 'The add-on keeps retrying the restore.';
  overnightRevertDeadlineCases().forEach((c, i) => {
    const g = GOLDEN.revertDeadline[i].push as { body: string };
    assert.ok(g.body.endsWith(RETRYING), `${c.name}: the golden ends with the retry sentence`);
    const stopped = buildNightChargeRevertDeadline({ ...c.input, retrying: false });
    assert.deepEqual(stopped, { ...g, body: g.body.slice(0, -RETRYING.length) + 'The add-on is not re-sending the restore.' }, c.name);
    assert.ok(!stopped.body.includes('retrying'), `${c.name}: no retry is claimed`);
    assert.doesNotMatch(revertDeadlineSpoken(c.input).en, /retr/i, `${c.name}: speech names no retry`);
  });
});

test('★★★ the missed-apply push: the golden words, through the formatter\'s clocks', () => {
  missedApplyCases().forEach((c, i) => {
    assert.deepEqual(buildNightChargeMissedApply(c.input), GOLDEN.missedApply[i].push, c.name);
  });
});

test('★★★ every overnight leg record takes the overnight words', () => {
  // A record from before the cycle record (no window kind), the legacy cost leg, an overnight backup.
  assert.equal(isMiddayLeg({}), false);
  assert.equal(isMiddayLeg({ windowKind: null }), false);
  assert.equal(isMiddayLeg(emptyLegState()), false);
  assert.equal(isMiddayLeg({ ...emptyLegState(), ...LEGACY_LEG_FIELDS }), false);
  const backup: ChargeLegState = { ...emptyLegState(), leg: 'backup', windowKind: 'overnight' };
  const midday: ChargeLegState = { ...emptyLegState(), leg: 'cost', windowKind: 'super_off_peak' };
  assert.equal(isMiddayLeg(backup), false);
  assert.equal(isMiddayLeg(midday), true);
});

/* ── the wiring (index.ts is not importable: its source is checked) ── */

const INDEX = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
const ROUTE = readFileSync(new URL('../src/chargeAnnounce.ts', import.meta.url), 'utf8');

test('★★★ index.ts: the evening job\'s overnight calls are the route\'s overnight branch, argument for argument', () => {
  // The push.
  assert.match(INDEX, /\n {4}const msg = buildNightChargeMessage\(plan, shape, supervisedCtx, armRefused, NIGHT_CHARGE_MODE\);\n/);
  assert.match(ROUTE, /\n {2}const push = buildNightChargeMessage\(plan, shape, supervised, armRefused, mode\);\n/);
  // The speech: the same six arguments, in the same order, from the same sources.
  const args = (src: string, ctx: string): string[] => {
    const at = src.indexOf('nightChargeSpokenNotice({');
    assert.ok(at > 0);
    const body = src.slice(at, src.indexOf('})', at));
    return body.split('\n').slice(1).map((l) => l.trim()).filter((l) => l.length > 0 && !l.startsWith('//')).map((l) => l.split(ctx).join('CTX'));
  };
  assert.equal(args(ROUTE, 'supervised.').length, 7, 'the seven arguments are read');
  assert.deepEqual(args(INDEX, 'supervisedCtx.'), args(ROUTE, 'supervised.'));
  // Spoken only beside an armed write, in both.
  assert.match(INDEX, /if \(supervisedCtx && plan\) \{\n/);
  assert.match(ROUTE, /if \(!supervised \|\| !plan\) return \{ push, spoken: null \};/);
});

test('★★★ index.ts: the summary and the revert page branch to the mid-day words only for a super off-peak leg, ahead of the overnight calls', () => {
  const revert = INDEX.slice(INDEX.indexOf("persistNightActuation({ ...state, revertedAtMs: nowMs, lastError: null });"));
  const mid = revert.indexOf('if (isMiddayLeg(state)) {');
  const night = revert.indexOf('void sendNotification(loadNotifyConfig(), buildNightChargeMorningSummary({');
  assert.ok(mid > 0 && night > mid, 'the mid-day branch comes first and returns');
  assert.match(revert.slice(mid, night), /\n {6}return;\n {4}\}\n/);
  const page = INDEX.slice(INDEX.indexOf('function pageRevertDeadline('), INDEX.indexOf('async function runNightActuationTickInner('));
  assert.match(page, /const midday = isMiddayLeg\(state as Partial<ChargeLegState>\)\n\s+\? middayRevertDeadlineFromLeg\(state, \{ stage: d\.stage, unknown: d\.unknown, targetPct, restorePct, nowMs, retrying \}\) : null;/);
  assert.match(page, /const spoken = midday != null \? middayRevertDeadlineSpoken\(midday\) : revertDeadlineSpoken\(\{ stage: d\.stage, unknown: d\.unknown, targetPct, restorePct, onPeakClock, onPeakDay \}\);/);
  assert.match(page, /midday != null \? buildMiddayRevertDeadline\(midday\) : buildNightChargeRevertDeadline\(\{\n\s+day: state\.day, stage: d\.stage, unknown: d\.unknown, targetPct, restorePct, onPeakClock, onPeakDay, retrying,\n/);
  // The on-peak day is named at the deadline stage only, from the page's own moment.
  assert.ok(page.includes("const onPeakDay = d.stage === 'deadline' && state.nextOnPeakStartMs != null ? onPeakDayWords(state.nextOnPeakStartMs, nowMs) : null;"));
  // The evening job arms the overnight leg alone in this release: no mid-day words reach it.
  const job = INDEX.slice(INDEX.indexOf('async function runNightChargeEveningJobInner('), INDEX.indexOf('R4 (v1.189.0) — THE WINTER MID-DAY CYCLE IN SHADOW'));
  assert.ok(job.length > 1000);
  for (const banned of ['buildMiddayPlanMessage', 'middaySpokenNotice', 'eveningAnnouncement', "kind: 'super_off_peak'"]) {
    assert.ok(!job.includes(banned), `${banned} in the evening job`);
  }
});
