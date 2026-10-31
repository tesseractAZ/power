import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMiddayPlanMessage, middaySpokenNotice, buildMiddayRefreshMessage, buildMiddayChargeSummary,
  middayRevertDeadlineSpoken, buildMiddayRevertDeadline, dayWord, dayText, dayTextEs, deDayEs, phxShortClock, phxClock,
  phxSpokenClock, spanText, onPeakSpanText, windowText, BACKUP_SPOKEN_LEG_KWH,
  type MiddayAnnounceInput, type MiddayCostText, type MiddayBackupText, type MiddayRefreshText,
} from '../src/chargeText.js';
import { eveningAnnouncement, middaySummaryFromLeg, middayRevertDeadlineFromLeg } from '../src/chargeAnnounce.js';
import { MAX_SPOKEN_ADVISORY_CHARS } from '../src/nightChargeActuator.js';
import { onPeakEndMs, nextOnPeakStartMs } from '../src/chargeWindows.js';
import { buildApsREvModel } from '../src/tariff.js';
import {
  middayShadowAnnounceInput, middayShadowPreview, middayShadowPreviewLogLines, middayShadowRefreshPreview,
  middayShadowRefreshPreviewLogLine, MIDDAY_SHADOW_LOG_TAG, refreshFromSized, middayShadowRefreshLedgerColumns,
  middayShadowRefreshLogLine, coerceMiddayShadowRecord, type MiddayShadowRecord, type ShadowRefresh,
} from '../src/middayShadow.js';

/**
 * R5 (v1.189.0) — THE MID-DAY WORDS (plan §5): the day-aware formatter, the 21:30 push and spoken
 * notice of a winter mid-day cycle (one leg or two), the morning refresh push, the summary at the
 * restore and the critical page. Until the mid-day switch none of them is sent: the shadow logs and
 * shows what the evening and the refresh would say (middayShadowPreview).
 *
 * The fixture is the plan's: Wednesday 2026-10-14 21:30, the outage backup Wed 23:00–Thu 05:00 and
 * the daytime charge Thu 10:00–15:00, the 4–7pm on-peak after it.
 */

const H = 3_600_000;
const M = 60_000;
const phx = (mo: number, d: number, h: number, mi = 0): number => Date.UTC(2026, mo - 1, d, h + 7, mi);
const NOW = phx(10, 14, 21, 30);
const MODEL = buildApsREvModel();

const COST: MiddayCostText = {
  windowStartMs: phx(10, 15, 10), windowEndMs: phx(10, 15, 15), levelPct: 89.6, reservePct: 50, expectedKwh: 34.1, buyKwh: 58.2,
  toward: false, forceCharge: true, charges: true, basisComplete: true, cushionShortfall: false,
};
const BACKUP: MiddayBackupText = {
  windowStartMs: phx(10, 14, 23), windowEndMs: phx(10, 15, 5), reservePct: 50, expectedKwh: 2.1, buyKwh: 12.3, cushionShortfall: false,
};
const input = (o: Partial<MiddayAnnounceInput> = {}): MiddayAnnounceInput => ({
  nowMs: NOW, mode: 'supervised', cost: COST, backup: null,
  onPeak: { startMs: phx(10, 15, 16), endMs: phx(10, 15, 19) },
  refreshAtMs: phx(10, 15, 9, 30), costApplyAtMs: phx(10, 15, 10), backupApplyAtMs: phx(10, 14, 23), costRestoreAtMs: phx(10, 15, 15),
  refused: null, ...o,
});
const chars = (t: { en: string; es: string }): number => t.en.length + t.es.length;

/* ══ the formatter ═══════════════════════════════════════════════════════════ */

test('★★★ the day-aware formatter names each window from the moment the text is written', () => {
  // Wednesday 21:30: the 23:00 backup is tonight, Thursday's window tomorrow.
  assert.equal(dayWord(phx(10, 14, 23), NOW), 'tonight');
  assert.equal(dayWord(phx(10, 15, 10), NOW), 'tomorrow');
  // Sunday 21:30: Monday 00:00 is still tonight; Monday 10:00 is tomorrow.
  assert.equal(dayWord(phx(10, 19, 0), phx(10, 18, 21, 30)), 'tonight');
  assert.equal(dayWord(phx(10, 19, 10), phx(10, 18, 21, 30)), 'tomorrow');
  // The refresh at 09:31: its window is today; a window two days out is named by its weekday.
  assert.equal(dayWord(phx(10, 15, 10), phx(10, 15, 9, 31)), 'today');
  assert.deepEqual(dayWord(phx(10, 19, 10), phx(10, 16, 21, 30)), { weekday: 'Monday' });
  // In the small hours, a 03:00 window the next day is tomorrow, not tonight.
  assert.equal(dayWord(phx(10, 16, 3), phx(10, 15, 2)), 'tomorrow');
  assert.equal(dayText({ weekday: 'Monday' }), 'Monday');
  assert.equal(dayTextEs('tomorrow'), 'mañana');
  assert.equal(dayTextEs({ weekday: 'Monday' }), 'el lunes');
  assert.equal(deDayEs('tomorrow'), 'de mañana');
  assert.equal(deDayEs({ weekday: 'Monday' }), 'del lunes');
  // The clocks.
  assert.equal(phxShortClock(phx(10, 15, 10)), '10am');
  assert.equal(phxShortClock(phx(10, 15, 9, 30)), '9:30am');
  assert.equal(phxShortClock(phx(10, 19, 0)), '12am');
  assert.equal(phxClock(phx(10, 15, 9, 30)), '9:30 AM');
  assert.equal(phxClock(phx(10, 15, 15)), '3:00 PM');
  assert.equal(phxSpokenClock(phx(10, 15, 10)), '10 AM');
  assert.equal(phxSpokenClock(phx(10, 19, 0)), '12 AM');
  assert.equal(phxSpokenClock(phx(10, 15, 13, 5)), '1:05 PM');
  assert.equal(spanText(phx(10, 14, 23), phx(10, 15, 5)), '11pm–5am');
  assert.equal(windowText(phx(10, 15, 10), phx(10, 15, 15), NOW), 'tomorrow 10am–3pm');
  // The on-peak span from the tariff: 4–7pm.
  const peak = nextOnPeakStartMs(MODEL, phx(10, 15, 10))!;
  assert.equal(peak, phx(10, 15, 16));
  assert.equal(onPeakEndMs(MODEL, peak), phx(10, 15, 19));
  assert.equal(onPeakSpanText(peak, onPeakEndMs(MODEL, peak)!), '4–7pm');
  assert.equal(onPeakSpanText(phx(10, 15, 11), phx(10, 15, 13)), '11am–1pm');
  assert.equal(onPeakEndMs(MODEL, phx(10, 15, 10)), null, 'not an on-peak hour');
});

/* ══ the 21:30 push ═════════════════════════════════════════════════════════ */

test('★★★ the 21:30 push: the plan\'s words — the level, the window, the expected kWh, the refresh, the restore before on-peak, the 10:00 cancel', () => {
  const m = buildMiddayPlanMessage(input());
  assert.equal(m.severity, 'info');
  assert.equal(m.dedupId, 'night_charge_plan', 'one updating card, as the overnight notice');
  assert.equal(m.title, 'Charge plan: charging to ~89.6% tomorrow 10am–3pm, about 34 kWh');
  assert.equal(m.body,
    'Tomorrow (Thu) 10am–3pm, APS super off-peak: charging the backup pool to ~89.6%, about 34 kWh of grid energy expected. '
    + 'The plan is refreshed with the morning solar forecast at 9:30 AM; it can only lower or cancel this charge. '
    + 'SUPERVISED: at 10:00 AM the backup reserve is held at 50% and Charge Now switches on just in time; both are restored at 3:00 PM, '
    + 'before the 4–7pm on-peak. Cancel from the charge card before 10:00 AM tomorrow. '
    + 'Sizing basis (the islanded worst case the plan is sized on, not the expected charge): ~58.2 kWh for the daytime charge.');
  // With the backup: its own line, its own cancel time.
  const two = buildMiddayPlanMessage(input({ backup: BACKUP }));
  assert.ok(two.body.includes(' Tonight 11pm–5am, outage backup: reserve held at 50%, about 2 kWh expected; cancel it separately on the card before 11:00 PM.'), two.body);
  assert.ok(two.body.endsWith('~58.2 kWh for the daytime charge, ~12.3 kWh for the outage backup.'));
  // A reserve-only leg: no Charge Now.
  const ro = buildMiddayPlanMessage(input({ cost: { ...COST, levelPct: 50, forceCharge: false, expectedKwh: 20 } }));
  assert.ok(ro.body.includes('SUPERVISED: at 10:00 AM the backup reserve is held at 50%; it is restored at 3:00 PM, before the 4–7pm on-peak.'), ro.body);
  assert.ok(!ro.body.includes('Charge Now'));
  // Toward: as far as the window can deliver.
  const tw = buildMiddayPlanMessage(input({ cost: { ...COST, toward: true, expectedKwh: 58 } }));
  assert.equal(tw.title, 'Charge plan: charging toward ~89.6% tomorrow 10am–3pm, about 58 kWh');
  assert.ok(tw.body.includes('charging the backup pool toward ~89.6%, as far as the window can deliver, about 58 kWh of grid energy expected.'));
  // A reserve held with no charge expected: said so, no figure.
  const held = buildMiddayPlanMessage(input({ cost: { ...COST, levelPct: 50, forceCharge: false, expectedKwh: 0.01 } }));
  assert.equal(held.title, 'Charge plan: reserve held at 50% tomorrow 10am–3pm — no charge expected');
  assert.ok(held.body.startsWith('Tomorrow (Thu) 10am–3pm, APS super off-peak: holding the backup reserve at 50% as a floor; no charge is expected.'));
  // The cushion: disclosed.
  const short = buildMiddayPlanMessage(input({ cost: { ...COST, cushionShortfall: true } }));
  assert.ok(short.body.includes(' NOTE: charge/pool limits prevent fully meeting the cushion — residual risk remains.'));
  // No expected figure: no kWh in the headline at all.
  const nofig = buildMiddayPlanMessage(input({ cost: { ...COST, expectedKwh: null } }));
  assert.equal(nofig.title, 'Charge plan: charging to ~89.6% tomorrow 10am–3pm');
});

test('★★★ the push shapes that arm nothing say so: advisory, refused (and no outage backup tonight), a daytime hold, no plan', () => {
  const adv = buildMiddayPlanMessage(input({ mode: 'advisory', backup: BACKUP }));
  assert.equal(adv.title, 'Charge plan: charge to ~89.6% recommended tomorrow 10am–3pm, about 34 kWh');
  assert.ok(adv.body.includes('Advisory only — the add-on will NOT charge.'));
  assert.ok(adv.body.includes('outage backup: reserve hold recommended at 50%'));
  assert.ok(!adv.body.includes('SUPERVISED') && !adv.body.includes('Cancel from the charge card'));
  const ref = buildMiddayPlanMessage(input({ refused: "the 2026-10-13 reserve write is still applied and not yet restored", backup: BACKUP }));
  assert.equal(ref.title, "Charge plan: tomorrow's 10am–3pm charge NOT armed");
  assert.equal(ref.body, 'The plan for tomorrow 10am–3pm calls for a charge, but the supervised write was not armed — the 2026-10-13 reserve write is still '
    + 'applied and not yet restored. The add-on will not charge tomorrow, and there is no outage backup tonight because the 2026-10-13 reserve '
    + 'write is still applied and not yet restored.');
  assert.match(buildMiddayPlanMessage(input({ mode: 'auto', refused: 'x' })).body, /but the write was not armed — x\./);
  const hold = buildMiddayPlanMessage(input({ cost: { ...COST, charges: false } }));
  assert.equal(hold.title, 'Charge plan: hold — no charge tomorrow 10am–3pm');
  const hb = buildMiddayPlanMessage(input({ cost: { ...COST, charges: false }, backup: { ...BACKUP, expectedKwh: 12 } }));
  assert.equal(hb.title, 'Charge plan: outage backup tonight 11pm–5am; no charge tomorrow 10am–3pm');
  const none = buildMiddayPlanMessage(input({ cost: { ...COST, basisComplete: false } }));
  assert.equal(none.title, 'Charge plan: no plan for tomorrow 10am–3pm');
  assert.equal(none.body, 'No charge plan for tomorrow 10am–3pm — the forecast/telemetry basis is incomplete, so nothing will be charged. '
    + '(This confirms the evening job ran; the reserve floor is unchanged.)', 'no reason (a record from before v1.196.0): the words before it');
  // v1.196.0 — the gate that refused the plan is stated, as the overnight "no plan tonight" push states it.
  const why = 'PV band coverage 72% < 78% (forecast present, tier=forecast, calDays 14/14)';
  const named = buildMiddayPlanMessage(input({ cost: { ...COST, basisComplete: false, basisBlockedBy: why } }));
  assert.equal(named.title, none.title);
  assert.equal(named.body, `No charge plan for tomorrow 10am–3pm — the forecast/telemetry basis is incomplete: ${why}, so nothing will be charged. `
    + '(This confirms the evening job ran; the reserve floor is unchanged.)');
  for (const blank of [null, '']) assert.equal(buildMiddayPlanMessage(input({ cost: { ...COST, basisComplete: false, basisBlockedBy: blank } })).body, none.body);
});

/* ══ the spoken notice ══════════════════════════════════════════════════════ */

test('★★★ the spoken notice: the plan\'s three shapes, word for word, and their lengths (359 / 485 / 501)', () => {
  const one = middaySpokenNotice(input())!;
  assert.equal(one.en, 'Charge notice. Tomorrow from 10 AM to 3 PM, charging the backup pool to about 90 percent, about 34 kilowatt hours. Cancel on the Power panel before 10 AM tomorrow.');
  assert.equal(one.es, 'Aviso de carga. Mañana de las 10 AM a las 3 PM, se cargarán las baterías de respaldo hasta cerca del 90 por ciento, unos 34 kilovatios hora. Cancele en el panel Power antes de las 10 AM de mañana.');
  assert.equal(chars(one), 359);
  const small = middaySpokenNotice(input({ backup: BACKUP }))!;
  assert.ok(small.en.includes(' Tonight the reserve is held at 50 percent as outage backup. Cancel on the Power panel before 10 AM tomorrow.'));
  assert.ok(small.es.includes(' Esta noche la reserva se mantiene en 50 por ciento como respaldo. Cancele'));
  assert.equal(chars(small), 485);
  const two = middaySpokenNotice(input({ backup: { ...BACKUP, expectedKwh: 12 }, cost: { ...COST, toward: true, expectedKwh: 58 } }))!;
  assert.equal(two.en, 'Charge notice. Tonight 11 PM to 5 AM, outage backup to about 50 percent, about 12 kilowatt hours. Tomorrow 10 AM to 3 PM, toward 90 percent, about 58 kilowatt hours. Cancel on the Power panel by 11 PM, or by 10 AM for the daytime charge.');
  assert.equal(two.es, 'Aviso de carga. Esta noche de 11 PM a 5 AM, respaldo hasta cerca del 50 por ciento, unos 12 kilovatios hora. Mañana de 10 AM a 3 PM, hacia el 90 por ciento, unos 58 kilovatios hora. Cancele en el panel Power antes de las 11 PM, o de las 10 AM para la carga de día.');
  assert.equal(chars(two), 501);
  // The backup speaks as a leg of its own from BACKUP_SPOKEN_LEG_KWH.
  assert.equal(BACKUP_SPOKEN_LEG_KWH, 5);
  assert.ok(middaySpokenNotice(input({ backup: { ...BACKUP, expectedKwh: 4.9 } }))!.en.includes('as outage backup.'));
  assert.ok(middaySpokenNotice(input({ backup: { ...BACKUP, expectedKwh: 5 } }))!.en.startsWith('Charge notice. Tonight 11 PM to 5 AM, outage backup'));
  // Nothing is spoken when nothing arms.
  assert.equal(middaySpokenNotice(input({ mode: 'advisory' })), null);
  assert.equal(middaySpokenNotice(input({ refused: 'x' })), null);
  assert.equal(middaySpokenNotice(input({ cost: { ...COST, basisComplete: false } })), null);
  assert.equal(middaySpokenNotice(input({ cost: { ...COST, charges: false } })), null, 'a hold with no backup says nothing');
});

test('★★★ the spoken notice stays within 560 characters in every shape, and never drops the level, the cancel or the cushion clause', () => {
  let worst = 0;
  const levels = [9, 50, 89.6, 100];
  const kwhs = [null, 0.01, 0.5, 1, 4.9, 12, 58, 99.6, 150];
  const backups: Array<MiddayBackupText | null> = [null, ...[0.01, 2, 5, 12, 45, 99.6].map((k) => ({ ...BACKUP, expectedKwh: k }))];
  const starts: Array<[number, number, number, number]> = [
    [NOW, phx(10, 14, 23), phx(10, 15, 10), phx(10, 15, 15)],
    [phx(10, 18, 21, 30), phx(10, 19, 0), phx(10, 19, 10), phx(10, 19, 15)], // Sunday: Monday 00:00
  ];
  for (const [now, bStart, cStart, cEnd] of starts) {
    for (const level of levels) for (const k of kwhs) for (const b of backups) for (const toward of [false, true]) for (const short of [false, true]) {
      const i = input({
        nowMs: now, costApplyAtMs: cStart, backupApplyAtMs: bStart, refreshAtMs: cStart - 30 * M, costRestoreAtMs: cEnd,
        cost: { ...COST, windowStartMs: cStart, windowEndMs: cEnd, levelPct: level, expectedKwh: k, toward, cushionShortfall: short },
        backup: b == null ? null : { ...b, windowStartMs: bStart, windowEndMs: bStart + (bStart === phx(10, 19, 0) ? 5 : 6) * H, cushionShortfall: short },
      });
      const t = middaySpokenNotice(i)!;
      const n = chars(t);
      worst = Math.max(worst, n);
      assert.ok(n <= MAX_SPOKEN_ADVISORY_CHARS, `${n} chars: ${t.en} / ${t.es}`);
      assert.ok(t.en.startsWith('Charge notice. ') && t.es.startsWith('Aviso de carga. '));
      assert.match(t.en, /Cancel on the Power panel (before|by) /, 'the cancel is always said');
      if (short) {
        assert.ok(t.en.includes('Outage cushion not fully met.'), t.en);
        assert.ok(t.es.includes('Margen de respaldo no cubierto por completo.'), t.es);
      }
      if (k == null || k >= 0.05) assert.ok(t.en.includes(`${Math.round(level)} percent`), `the level: ${t.en}`);
    }
  }
  assert.ok(worst > 500, `the grid reaches the long shapes (${worst})`);
});

test('★★★ the spoken notice never speaks a placeholder, names a far window by its weekday, and its last shape fits whatever the figures', () => {
  // No level and no reserve on record: the words leave the figure unsaid ("—" is never spoken).
  for (const b of [null, BACKUP, { ...BACKUP, expectedKwh: 12 }, { ...BACKUP, reservePct: null }, { ...BACKUP, reservePct: null, expectedKwh: 12 }]) {
    for (const cost of [
      { ...COST, levelPct: null, reservePct: null }, { ...COST, levelPct: null }, { ...COST, levelPct: null, reservePct: null, expectedKwh: 0.01 },
      { ...COST, charges: false, levelPct: null, reservePct: null },
    ]) {
      const t = middaySpokenNotice(input({ cost, backup: b }));
      if (t == null) continue;
      assert.ok(!t.en.includes('—') && !t.es.includes('—'), `${t.en} / ${t.es}`);
      assert.doesNotMatch(t.en + t.es, /percent percent|por ciento por ciento| {2}| [.,;]/, 'no doubled words, doubled spaces or a space before punctuation');
    }
  }
  // The level falls back to the reserve the write holds.
  assert.match(middaySpokenNotice(input({ cost: { ...COST, levelPct: null } }))!.en, /charging the backup pool to about 50 percent/);
  // Written two evenings ahead (a holiday scan): the window is named by its weekday, in both languages.
  const far = middaySpokenNotice(input({ nowMs: phx(10, 13, 21, 30) }))!;
  assert.match(far.en, /^Charge notice\. Thursday from 10 AM to 3 PM,/);
  assert.match(far.es, /^Aviso de carga\. El jueves de las 10 AM a las 3 PM,/);
  assert.match(far.es, /antes de las 10 AM del jueves\.$/);
  // Figures no plan produces push every fuller shape over the bound: the last one is still within
  // it, and still says the level, the cancel time and the cushion clause.
  for (const backup of [null, { ...BACKUP, expectedKwh: 1e20 }, { ...BACKUP, expectedKwh: 2 }]) {
    const t = middaySpokenNotice(input({
      nowMs: phx(10, 13, 21, 30), backup,
      cost: { ...COST, levelPct: 100, expectedKwh: 1e20, toward: true, cushionShortfall: true },
    }))!;
    assert.ok(chars(t) <= MAX_SPOKEN_ADVISORY_CHARS, `${chars(t)}: ${t.en} / ${t.es}`);
    assert.match(t.en, /toward 100 percent/);
    assert.match(t.en, /Outage cushion not fully met\./);
    assert.match(t.en, /Cancel on the Power panel (before|by) /);
  }
  // Both legs with figures that long: only the last shape fits — the figures are what it drops.
  const last = middaySpokenNotice(input({
    nowMs: phx(10, 13, 21, 30), backup: { ...BACKUP, expectedKwh: 1e20 },
    cost: { ...COST, levelPct: 100, expectedKwh: 1e20, toward: true, cushionShortfall: true },
  }))!;
  assert.equal(last.en, 'Charge notice. Thursday 10 AM to 3 PM, toward 100 percent. Outage backup tomorrow at 50 percent. Outage cushion not fully met. '
    + 'Cancel on the Power panel by 11 PM, or by 10 AM for the daytime charge.');
  assert.equal(last.es, 'Aviso de carga. El jueves de 10 AM a 3 PM, hacia el 100 por ciento. Respaldo mañana en el 50 por ciento. Margen de respaldo no cubierto por completo. '
    + 'Cancele en el panel Power antes de las 11 PM, o de las 10 AM para la carga de día.');
});

test('★★★ the critical page fits whatever the figures, and always says the reserve to set', () => {
  const p = middayRevertDeadlineFromLeg(
    { windowStartMs: phx(10, 15, 10), windowEndMs: phx(10, 15, 15), nextOnPeakStartMs: phx(10, 15, 16), forceChargeOnAtMs: phx(10, 15, 13), forceChargeOffVerifiedAtMs: null },
    { stage: 'onPeak', unknown: false, targetPct: 1e15, restorePct: 1e15, nowMs: phx(10, 15, 16), retrying: true },
  );
  for (const stage of ['deadline', 'onPeak'] as const) for (const unknown of [true, false]) {
    const t = middayRevertDeadlineSpoken({ ...p, stage, unknown });
    assert.ok(chars(t) <= MAX_SPOKEN_ADVISORY_CHARS, `${stage}/${unknown}: ${chars(t)}`);
    assert.match(t.en, /Set the (backup )?reserve to 1000000000000000 percent and switch Charge Now off in the EcoFlow app\.$/);
    assert.ok(t.es.startsWith('Alarma crítica. Alarma crítica. '));
  }
});

test('★★★ no worst-case figure in a push title, a push headline or speech — only on the labelled sizing line', () => {
  const W = 77.7; // a figure no other term produces
  for (const cost of [COST, { ...COST, toward: true }, { ...COST, expectedKwh: null }, { ...COST, expectedKwh: 0.01, levelPct: 50, forceCharge: false }]) {
    for (const backup of [null, { ...BACKUP, buyKwh: W }]) {
      for (const mode of ['supervised', 'auto', 'advisory'] as const) {
        const i = input({ mode, cost: { ...cost, buyKwh: W }, backup });
        const m = buildMiddayPlanMessage(i);
        assert.ok(!m.title.includes('77.7') && !m.title.includes('78 kWh'), m.title);
        const basis = m.body.indexOf(' Sizing basis (the islanded worst case the plan is sized on, not the expected charge): ');
        assert.ok(basis > 0, m.body);
        assert.ok(!m.body.slice(0, basis).includes('77.7') && !m.body.slice(0, basis).includes('78 kWh'), m.body);
        const s = middaySpokenNotice(i);
        if (s) assert.ok(!/77|78 kilo/.test(s.en + s.es), s.en);
      }
    }
  }
});

/* ══ the morning refresh push ═══════════════════════════════════════════════ */

const refreshText = (o: Partial<MiddayRefreshText> = {}): MiddayRefreshText => ({
  nowMs: phx(10, 15, 9, 31), windowStartMs: phx(10, 15, 10), windowEndMs: phx(10, 15, 15), announcedAtMs: NOW,
  disposition: 'unchanged', announced: { levelPct: 89.6, expectedKwh: 34 },
  refreshed: { levelPct: 89.6, reservePct: 50, expectedKwh: 22 }, neededLevelPct: 89.6,
  windowPvKwh: { announced: 9, refreshed: 14 }, reservePct: 16, applyAtMs: phx(10, 15, 10), wouldPush: true, ...o,
});

test('★★★ the refresh push: a moved figure, a lowered level, a cap, a cancel — and nothing when it would not push', () => {
  const moved = buildMiddayRefreshMessage(refreshText())!;
  assert.equal(moved.title, 'Charge plan updated: still ~89.6% today 10am–3pm, now about 22 kWh');
  assert.equal(moved.body, 'Still ~89.6% today 10am–3pm, now about 22 kWh (announced last night: about 34 kWh) — the morning solar forecast for the '
    + 'window is higher (~14 kWh, was ~9 kWh). Cancel from the charge card before 10:00 AM.');
  assert.equal(moved.dedupId, 'night_charge_plan', 'it updates the evening card');
  assert.match(buildMiddayRefreshMessage(refreshText({ windowPvKwh: { announced: null, refreshed: 14 } }))!.body, /— re-planned on the morning solar forecast\./);
  const lowered = buildMiddayRefreshMessage(refreshText({ disposition: 'lowered', refreshed: { levelPct: 80, reservePct: 45, expectedKwh: 22 } }))!;
  assert.equal(lowered.title, 'Charge plan updated: now ~80% today 10am–3pm, about 22 kWh');
  assert.match(lowered.body, /^Lowered to ~80% today 10am–3pm \(announced last night: ~89\.6%\), now about 22 kWh .* The reserve is held at 45% from the open\. Cancel/);
  const capped = buildMiddayRefreshMessage(refreshText({ disposition: 'capped', neededLevelPct: 95, refreshed: { levelPct: 89.6, reservePct: 50, expectedKwh: null } }))!;
  assert.equal(capped.title, 'Charge plan updated: held at the announced ~89.6% today 10am–3pm');
  assert.match(capped.body, /calls for more \(~95%\), but a refresh never raises an announced charge: today 10am–3pm stays at ~89\.6%\./);
  const cancelled = buildMiddayRefreshMessage(refreshText({ disposition: 'cancelled', refreshed: { levelPct: null, reservePct: null, expectedKwh: 0 } }))!;
  assert.equal(cancelled.title, "Charge plan updated: today's 10am–3pm charge is cancelled");
  assert.match(cancelled.body, /nothing will be written, and the reserve stays at 16%\.$/);
  assert.equal(buildMiddayRefreshMessage(refreshText({ wouldPush: false })), null);
  assert.equal(buildMiddayRefreshMessage(refreshText({ disposition: 'stood' })), null);
  // It never states a figure it was not given.
  assert.ok(!capped.body.includes('kWh'));
  // A cap from the reserve alone — the re-plan's level at or under the announced one — names the
  // reserve it asked for and the one held, never "more" than a level it did not ask above.
  const reserveCap = buildMiddayRefreshMessage(refreshText({
    disposition: 'capped', neededLevelPct: 80, neededReservePct: 50, refreshed: { levelPct: 89.6, reservePct: 40, expectedKwh: null },
  }))!;
  assert.equal(reserveCap.title, 'Charge plan updated: held at the announced ~89.6% today 10am–3pm');
  assert.equal(reserveCap.body, 'The morning re-plan calls for a higher reserve (50%), but a refresh never raises what was announced: '
    + 'today 10am–3pm stays at ~89.6%, with the reserve held at 40% from the open. Cancel from the charge card before 10:00 AM.');
  // A level cap keeps its words with a reserve figure beside it; a reserve cap with no figures
  // still says it is the reserve.
  assert.match(buildMiddayRefreshMessage(refreshText({
    disposition: 'capped', neededLevelPct: 95, neededReservePct: 50, refreshed: { levelPct: 89.6, reservePct: 40, expectedKwh: null },
  }))!.body, /calls for more \(~95%\)/);
  const bare = buildMiddayRefreshMessage(refreshText({
    disposition: 'capped', neededLevelPct: 89.6, refreshed: { levelPct: 89.6, reservePct: null, expectedKwh: null },
  }))!.body;
  assert.match(bare, /^The morning re-plan calls for a higher reserve, but a refresh never raises what was announced: today 10am–3pm stays at ~89\.6%\. Cancel/);
  assert.doesNotMatch(bare, /calls for more/);
});

/* ══ the summary and the critical ═══════════════════════════════════════════ */

test('★★★ the summary at the restore: what the leg did, its restore time before on-peak; the figure only beside the legs it counts', () => {
  const leg = { windowStartMs: phx(10, 15, 10), windowEndMs: phx(10, 15, 15), targetPct: 50, forceChargeOffAtMs: phx(10, 15, 14, 41), forceChargeOffReason: 'target' };
  const base = {
    restorePct: 16, restoredAtMs: phx(10, 15, 15), expectedKwh: 34.1,
    onPeak: { startMs: phx(10, 15, 16), endMs: phx(10, 15, 19) }, ended: 'window' as const,
  };
  const ran = buildMiddayChargeSummary(middaySummaryFromLeg(leg, { ...base, forceCharge: { kind: 'ran', stopPct: 89.6, expectedLeg: true } }));
  assert.equal(ran.title, 'Charge (Thu 10am–3pm): reserve restored to 16%');
  assert.equal(ran.body, 'Charge (Thu 10am–3pm) completed: reserve held at 50%, and Charge Now switched off at ~89.6% at 2:41 PM (about 34 kWh expected); '
    + 'the reserve was restored to 16% at 3:00 PM, before the 4–7pm on-peak. Delivery vs plan scores in the ledger after the cycle ends.');
  // Switched off by the window close, not the target: "ran toward".
  const closed = buildMiddayChargeSummary(middaySummaryFromLeg({ ...leg, forceChargeOffReason: 'windowEnd' }, { ...base, forceCharge: { kind: 'ran', stopPct: 89.6, expectedLeg: true } }));
  assert.match(closed.body, /Charge Now ran toward ~89\.6% and switched off at 2:41 PM/);
  // Reserve only; a figure that counts a force-charge leg is not stated beside it.
  assert.match(buildMiddayChargeSummary(middaySummaryFromLeg(leg, { ...base, forceCharge: { kind: 'none', expectedLeg: false } })).body,
    /completed: reserve held at 50% \(about 34 kWh expected\); the reserve was restored to 16% at 3:00 PM/);
  assert.ok(!buildMiddayChargeSummary(middaySummaryFromLeg(leg, { ...base, forceCharge: { kind: 'none', expectedLeg: true } })).body.includes('expected)'));
  assert.ok(!buildMiddayChargeSummary(middaySummaryFromLeg(leg, { ...base, forceCharge: { kind: 'neverStarted', stopPct: 89.6, expectedLeg: true } })).body.includes('kWh'));
  assert.match(buildMiddayChargeSummary(middaySummaryFromLeg(leg, { ...base, forceCharge: { kind: 'failed', stopPct: 89.6, expectedLeg: true, partialSlots: [2] } })).body,
    /did not take effect on slot\(s\) 2/);
  const held = buildMiddayChargeSummary(middaySummaryFromLeg(leg, { ...base, expectedKwh: 0.01, forceCharge: { kind: 'none', expectedLeg: false } }));
  assert.match(held.body, /the reserve was held at 50% as a floor \(no charge was expected\); the reserve was restored/);
  const cancelled = buildMiddayChargeSummary(middaySummaryFromLeg(leg, { ...base, forceCharge: null, ended: 'cancelled' }));
  assert.equal(cancelled.title, 'Charge (Thu 10am–3pm): cancelled — reserve restored to 16%');
  assert.ok(!cancelled.body.includes('kWh'));
  assert.match(buildMiddayChargeSummary(middaySummaryFromLeg(leg, { ...base, forceCharge: null, ended: 'gridLoss' })).title, /stopped \(grid lost\)/);
});

test('★★★ the critical page: the window, the on-peak start, the reserve to set — and Charge Now when its OFF has not read back; within 560', () => {
  const leg = { windowStartMs: phx(10, 15, 10), windowEndMs: phx(10, 15, 15), nextOnPeakStartMs: phx(10, 15, 16), forceChargeOnAtMs: phx(10, 15, 13), forceChargeOffVerifiedAtMs: null };
  const p = middayRevertDeadlineFromLeg(leg, { stage: 'deadline', unknown: true, targetPct: 50, restorePct: 16, nowMs: phx(10, 15, 15, 30), retrying: false });
  assert.equal(p.forceChargeOffOpen, true);
  const t = middayRevertDeadlineSpoken(p);
  assert.equal(t.en, 'Critical. The 10 AM to 3 PM charge could not be confirmed stopped: the panel is not reporting its reserve, and on-peak pricing starts at 4 PM. '
    + 'Set the backup reserve to 16 percent and switch Charge Now off in the EcoFlow app.');
  assert.ok(t.es.startsWith('Alarma crítica. Alarma crítica. '), 'the bilingual second pass');
  const off = middayRevertDeadlineFromLeg({ ...leg, forceChargeOffVerifiedAtMs: phx(10, 15, 15) }, { stage: 'deadline', unknown: false, targetPct: 50, restorePct: 16, nowMs: phx(10, 15, 15, 30), retrying: true });
  // The push says the restore is retried only while one will still be sent (revertRetryPending).
  assert.match(buildMiddayRevertDeadline(off).body, /in the EcoFlow app\. The add-on keeps retrying the restore\.$/);
  assert.match(buildMiddayRevertDeadline(p).body, /in the EcoFlow app\. The add-on is not re-sending the restore\.$/);
  assert.doesNotMatch(buildMiddayRevertDeadline(p).body, /retrying/);
  assert.equal(off.forceChargeOffOpen, false);
  assert.ok(!middayRevertDeadlineSpoken(off).en.includes('Charge Now'));
  assert.match(middayRevertDeadlineSpoken(off).en, /still reads 50 percent instead of 16 percent/);
  for (const stage of ['deadline', 'onPeak'] as const) for (const unknown of [true, false]) for (const restorePct of [16, null]) for (const fc of [true, false]) {
    const q = { ...p, stage, unknown, restorePct, forceChargeOffOpen: fc };
    const s = middayRevertDeadlineSpoken(q);
    assert.ok(chars(s) <= MAX_SPOKEN_ADVISORY_CHARS, `${stage}/${unknown}/${restorePct}/${fc}: ${chars(s)}`);
    assert.ok(s.en.startsWith('Critical.'));
    if (unknown) assert.doesNotMatch(s.en, /still reads/, 'no reading is never said to read raised');
    const push = buildMiddayRevertDeadline(q);
    assert.equal(push.severity, 'critical');
    assert.equal(push.dedupId, 'night_charge_revert_deadline');
    assert.match(push.title, /^Charge \(Thu 10am–3pm\): reserve (restore not confirmed|still raised)$/);
    assert.equal(push.body.includes('switch Charge Now off'), fc);
  }
  // The on-peak page with a reading runs over the bound in full: it is said compactly (the reserve to
  // set and Charge Now stay; the consequence becomes a clause).
  assert.equal(middayRevertDeadlineSpoken({ ...p, stage: 'onPeak', unknown: false, forceChargeOffOpen: false }).en,
    'Critical. On-peak pricing has started and the reserve still reads 50 percent instead of 16 percent after the 10 AM to 3 PM charge, so the house buys at the peak rate. '
    + 'Set the reserve to 16 percent in the EcoFlow app.');
  assert.equal(middayRevertDeadlineSpoken({ ...p, stage: 'onPeak', unknown: false }).en,
    'Critical. On-peak pricing has started and the reserve still reads 50 percent instead of 16 percent after the 10 AM to 3 PM charge, so the house buys at the peak rate. '
    + 'Set the reserve to 16 percent and switch Charge Now off in the EcoFlow app.');
});

/* ══ the shadow's preview: what the evening and the refresh would say, never sent ══ */

function record(o: Partial<MiddayShadowRecord> = {}): MiddayShadowRecord {
  const leg = (role: 'backup' | 'cost', a: number, b: number, x: Record<string, unknown> = {}) => ({
    role, kind: role === 'cost' ? 'super_off_peak' as const : 'overnight' as const, windowStartMs: a, windowEndMs: b,
    basisComplete: true, chargeTonight: true, reservePct: 50, reserveBasis: role === 'cost' ? 'resilience' as const : null,
    levelPct: role === 'cost' ? 89.6 : 50, costCeilingSocPct: role === 'cost' ? 89.6 : null,
    buyKwh: role === 'cost' ? 58.2 : 12.3, expectedBuyKwh: role === 'cost' ? 34.1 : 2.1, expectedStartSocPct: 48,
    cushionTroughSocPct: 20, cushionLineSocPct: 31.13, wouldArm: true, disposition: 'would arm', windowPvP50Kwh: 9, windowLoadP50Kwh: 14.9,
    toward: false, cushionShortfall: false, ...x,
  });
  return {
    version: 1, day: '2026-10-14', computedAtMs: NOW, why: 'midday', mode: 'supervised',
    backup: leg('backup', phx(10, 14, 23), phx(10, 15, 5)), cost: leg('cost', phx(10, 15, 10), phx(10, 15, 15)),
    refresh: null, note: null, ...o,
  };
}

test('★★★ the shadow preview: the evening\'s push and speech for the shadow cycle, from the record and the tariff — logged as not sent', () => {
  const r = record();
  const i = middayShadowAnnounceInput(r, MODEL)!;
  assert.deepEqual(i.onPeak, { startMs: phx(10, 15, 16), endMs: phx(10, 15, 19) });
  assert.equal(i.refreshAtMs, phx(10, 15, 9, 30));
  assert.equal(i.costApplyAtMs, phx(10, 15, 10));
  assert.equal(i.costRestoreAtMs, phx(10, 15, 15), 'min(the close, an hour before on-peak)');
  assert.equal(i.cost.forceCharge, true, 'a level above the reserve is a force-charge leg');
  assert.equal(i.refused, null);
  const p = middayShadowPreview(r, MODEL)!;
  assert.deepEqual(p.push, buildMiddayPlanMessage(i));
  assert.deepEqual(p.spoken, eveningAnnouncement({ cycle: 'midday', midday: i }).spoken);
  assert.equal(p.spokenChars, 485);
  const lines = middayShadowPreviewLogLines(r, MODEL);
  assert.equal(lines.length, 2);
  assert.ok(lines[0].startsWith(`${MIDDAY_SHADOW_LOG_TAG} 2026-10-14 the 21:30 push would read (not sent): "Charge plan: charging to ~89.6% tomorrow 10am–3pm, about 34 kWh"`));
  assert.ok(lines[1].startsWith(`${MIDDAY_SHADOW_LOG_TAG} 2026-10-14 the notice would be spoken (not spoken; 485 of 560 characters): "Charge notice.`));
  // A backup that would not arm is not named; one the probe refused, with the cost leg, refuses the cycle.
  const nb = middayShadowAnnounceInput(record({ backup: { ...r.backup!, wouldArm: false, chargeTonight: false } }), MODEL)!;
  assert.equal(nb.backup, null);
  const na = middayShadowAnnounceInput(record({ backup: { ...r.backup!, wouldArm: false, disposition: 'would not arm — x' } }), MODEL)!;
  assert.equal(na.backup, null, 'a backup that would not arm is not announced');
  const refused = middayShadowAnnounceInput(record({
    cost: { ...r.cost!, wouldArm: false, disposition: 'would not arm — the 2026-10-13 reserve write is still applied and not yet restored' },
  }), MODEL)!;
  assert.equal(refused.refused, 'the 2026-10-13 reserve write is still applied and not yet restored');
  // A refused cycle names the backup the plan called for: "no outage backup tonight because …".
  const refusedBoth = record({
    backup: { ...r.backup!, wouldArm: false, disposition: 'would not arm — x' },
    cost: { ...r.cost!, wouldArm: false, disposition: 'would not arm — x' },
  });
  assert.notEqual(middayShadowAnnounceInput(refusedBoth, MODEL)!.backup, null);
  assert.match(middayShadowPreview(refusedBoth, MODEL)!.push.body, /, and there is no outage backup tonight because x\.$/);
  assert.equal(middayShadowPreview(record({ cost: { ...r.cost!, wouldArm: false, disposition: 'would not arm — x' } }), MODEL)!.spoken, null, 'nothing armed: nothing spoken');
  // Advisory: recommended, nothing spoken.
  const adv = middayShadowPreview(record({ mode: 'advisory', backup: { ...r.backup!, wouldArm: false }, cost: { ...r.cost!, wouldArm: false, disposition: 'not armed — the night-charge mode is advisory' } }), MODEL)!;
  assert.match(adv.push.title, /recommended/);
  assert.equal(adv.spoken, null);
  assert.equal(middayShadowPreviewLogLines(record({ mode: 'advisory', cost: { ...r.cost!, wouldArm: false } }), MODEL).length, 1);
  // v1.196.0 — a refused cost leg's gate reaches the "no plan" push; a record from before it (no gate)
  // reads as before, and a complete leg passes none.
  assert.equal(i.cost.basisBlockedBy, null);
  const gate = 'SoC telemetry incoherent (% vs remaining/full mismatch)';
  const unplanned = { ...r.cost!, basisComplete: false, chargeTonight: false, wouldArm: false, disposition: `not armed — the plan basis is incomplete (${gate})` };
  const ri = middayShadowAnnounceInput(record({ cost: { ...unplanned, basisBlockedBy: gate } }), MODEL)!;
  assert.equal(ri.cost.basisBlockedBy, gate);
  assert.match(middayShadowPreview(record({ cost: { ...unplanned, basisBlockedBy: gate } }), MODEL)!.push.body,
    /^No charge plan for tomorrow 10am–3pm — the forecast\/telemetry basis is incomplete: SoC telemetry incoherent \(% vs remaining\/full mismatch\), so nothing will be charged\. /);
  assert.match(middayShadowPreview(record({ cost: unplanned }), MODEL)!.push.body, /— the forecast\/telemetry basis is incomplete, so nothing will be charged\. /);
  assert.equal(middayShadowAnnounceInput(record({ cost: { ...r.cost!, basisBlockedBy: gate } }), MODEL)!.cost.basisBlockedBy, null,
    'a complete leg names no gate');
  // The gate survives the record's file (coerceMiddayShadowRecord); an older record has none.
  const back = coerceMiddayShadowRecord(JSON.parse(JSON.stringify(record({ cost: { ...unplanned, basisBlockedBy: gate } }))))!;
  assert.equal(back.cost!.basisBlockedBy, gate);
  assert.equal('basisBlockedBy' in coerceMiddayShadowRecord(JSON.parse(JSON.stringify(record({ cost: unplanned }))))!.cost!, false);
  // No mid-day leg: no preview.
  assert.equal(middayShadowPreview(record({ cost: null, backup: null, why: 'no-run-in-scan' }), MODEL), null);
  assert.deepEqual(middayShadowPreviewLogLines(record({ cost: null, backup: null, why: 'no-run-in-scan' }), MODEL), []);
  assert.equal(middayShadowPreview(null, MODEL), null);
});

test('★★ the refresh preview: the push a live refresh would send, from the evening record — none when it would not push', () => {
  const r = record();
  const rf: ShadowRefresh = {
    atMs: phx(10, 15, 9, 31), disposition: 'unchanged', levelPct: 89.6, reservePct: 50, buyKwh: 50, expectedBuyKwh: 22,
    wouldPush: true, reason: 'the evening plan holds as announced', weatherAgeS: 1500, neededLevelPct: 89.6, windowPvP50Kwh: 14,
  };
  const m = middayShadowRefreshPreview(r, rf)!;
  assert.equal(m.title, 'Charge plan updated: still ~89.6% today 10am–3pm, now about 22 kWh');
  assert.match(m.body, /the morning solar forecast for the window is higher \(~14 kWh, was ~9 kWh\)/);
  assert.ok(middayShadowRefreshPreviewLogLine(r, rf)!.startsWith(`${MIDDAY_SHADOW_LOG_TAG} 2026-10-14 the refresh push would read (not sent): `));
  assert.equal(middayShadowRefreshPreview(r, { ...rf, wouldPush: false }), null);
  assert.equal(middayShadowRefreshPreviewLogLine(r, { ...rf, wouldPush: false }), null);
  assert.equal(middayShadowRefreshPreview({ ...r, cost: null }, rf), null);
});

test('★★ the shadow refresh records how old its weather was: on the record, the log and the ledger', () => {
  const r = record();
  const now = phx(10, 15, 9, 31);
  const p = { basisComplete: true, chargeTonight: true, setpointSocPct: 50, expectedWriteLevelPct: 89.6, expectedForceChargeStartMs: phx(10, 15, 13), expectedBuyKwh: 22, buyKwh: 50 };
  const rf = refreshFromSized(r, { plan: p as never, windowPvP50Kwh: 14, windowLoadP50Kwh: 15, weatherFetchedAtMs: now - 25 * M }, now);
  assert.equal(rf.weatherAgeS, 1500);
  assert.equal(rf.windowPvP50Kwh, 14);
  assert.equal(rf.neededLevelPct, 89.6);
  assert.equal(middayShadowRefreshLedgerColumns(rf).shadow_refresh_weather_age_s, 1500);
  assert.match(middayShadowRefreshLogLine(r, rf), /; sized on weather 25 min old;/);
  assert.equal(refreshFromSized(r, { plan: p as never, windowPvP50Kwh: 14, windowLoadP50Kwh: 15 }, now).weatherAgeS, null, 'unknown');
  // A record from before R5 (no age) round-trips without one.
  assert.equal(coerceMiddayShadowRecord(JSON.parse(JSON.stringify({ ...r, refresh: { ...rf, weatherAgeS: undefined } })))!.refresh!.weatherAgeS, undefined);
  assert.equal(coerceMiddayShadowRecord(JSON.parse(JSON.stringify({ ...r, refresh: rf })))!.refresh!.weatherAgeS, 1500);
});
