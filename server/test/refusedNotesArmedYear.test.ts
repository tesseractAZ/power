import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { computeNightChargePlan, buildNightChargeInputs, type NightChargePlan } from '../src/nightChargeAdvisor.js';
import { buildNightChargeMessage } from '../src/notify.js';
import { buildMiddayPlanMessage } from '../src/chargeText.js';
import { lineOverReserveText } from '../src/nightForceCharge.js';
import {
  summariseLeg, coerceMiddayShadowRecord, middayShadowAnnounceInput, middayShadowLogLines, type MiddayShadowRecord,
} from '../src/middayShadow.js';
import { buildApsREvModel } from '../src/tariff.js';
import { legacyIdentityCases } from './fixtures/legacyIdentityFixtures.js';
import { MEASURED_SCALE } from './fixtures/measuredCushionLineFigures.js';

/**
 * ★★★ v1.205.1 (review F1, T5) — THE ARMED RENDERS THE MID-DAY WORDING CHANGE MOVES, the year over.
 *
 * The mid-day "the outage line is above … and no force-charge carries it on this leg / on the backup leg" note, and the shadow's
 * evening log line for the backup leg, are worded by the named leg's own line (chargeText.ts notCarried, middayShadow.ts
 * middayShadowLogLines: lineOverReserveText). That moves ARMED renders: where the leg's line is at or below 50 the words name "the 49%
 * the panel holds the pool at under the 50% it accepts as a reserve", as the overnight envelope note of the same night does, where
 * v1.205.0 named "the 50% the panel accepts as a reserve". refusedNotes.test.ts RN-2's armed hash cannot see them: it sweeps plans with
 * the line gate on and no backup leg. This sweep is the rest: the fixture year's 21:30 plans at 4-20 h on both pools, the cost leg with
 * the line gate on beside the night's own backup leg, and with the gate off with and without it, in the three modes, ARMED (would
 * arm; advisory recommends), through the record (summariseLeg, a restore, middayShadowAnnounceInput) — the push and the evening log
 * lines — and the gate-off night's armed and advisory 21:30 push.
 *
 * What it pins:
 *  - with the one correction undone (the 49% form put back to the 50% form in those two notes and nothing else), every render hashes
 *    to v1.205.0's: captured by running this file at 8e8c13f4, where the undo is the identity;
 *  - every such note, in every render, is worded by its own leg's line (lineOverReserveText of it), never the other leg's;
 *  - the renders that move: how many, of which note, and that each names a line in [49.00, 50.00] (49.00: 2027-08-31 21:30 at ×0.944,
 *    7 h, gate off, as that night's overnight push names it; 50.00: the backup leg of 2026-11-25 21:30 on nameplate, 11 h).
 */

const CASES = legacyIdentityCases();
const live = (d: Record<string, unknown>) => ({ ...d, forceChargeEligible: d.objectiveMode === 'cost' && ((d.costMaxSocPct as number | undefined) ?? 90) > 50 });
const planAt = (label: string, b: 'np' | 'm', h: number, lineGate: boolean): NightChargePlan => computeNightChargePlan({
  ...buildNightChargeInputs({
    ...live(CASES.find((c) => c.label === label)!.deps as unknown as Record<string, unknown>), outageCushionHours: h,
    ...(b === 'm' ? { cushionPoolScale: MEASURED_SCALE } : {}), lineForceChargeEligible: lineGate,
  } as never)!,
} as never);

const MODEL = buildApsREvModel();
const phx = (mo: number, d: number, h: number, mi = 0): number => Date.UTC(2026, mo - 1, d, h + 7, mi);
const COST_LEG = { role: 'cost', kind: 'super_off_peak', startMs: phx(10, 15, 10), endMs: phx(10, 15, 15) } as const;
const BACKUP_LEG = { role: 'backup', kind: 'overnight', startMs: phx(10, 14, 23), endMs: phx(10, 15, 5) } as const;
type Mode = 'supervised' | 'auto' | 'advisory';
const armOf = (mode: Mode) => (mode === 'advisory'
  ? { wouldArm: false, disposition: 'not armed — the night-charge mode is advisory' } : { wouldArm: true, disposition: 'would arm' });
const SUP = { targetPct: 50, cancelDeadlineText: 'Until 11:00 PM', forceChargeTargetPct: null };

const OVER_RESERVE = lineOverReserveText(Infinity, 'accepts');
const OVER_HELD = lineOverReserveText(50, 'accepts');
const NOTE = / NOTE: the outage line is above (the [^—]*?) and no force-charge carries it on (this leg|the backup leg) — residual risk remains\./g;
const LOG = /; the line is above (the [^—]*?), and the backup leg writes the reserve only — residual risk remains/g;
/** v1.205.1's correction undone: the 49% form put back to v1.205.0's 50% form in the two notes, and nothing else. */
const undo = (s: string): string => s
  .replaceAll(` NOTE: the outage line is above ${OVER_HELD} and no force-charge carries it on`, ` NOTE: the outage line is above ${OVER_RESERVE} and no force-charge carries it on`)
  .replaceAll(`; the line is above ${OVER_HELD}, and the backup leg writes the reserve only`, `; the line is above ${OVER_RESERVE}, and the backup leg writes the reserve only`);

/** Every render, with the correction undone, hashed: captured at 8e8c13f4 (v1.205.0). */
const PIN_V1205 = { renders: 459170, sha256: '59aa2d8f862f969be46547b81c7071cb44102efea1495da86973b33360073d5c' };
/** The renders the correction moves (with the line gate on and no backup leg, none: RN-2). */
const PIN_MOVED = {
  renders: 2430, records: 1458, configurations: 486,
  byNote: { 'this leg': 972, 'the backup leg': 486, 'backup log': 972 },
  lines: { min: 49, max: 50 },
};

test('★★★ RN-8 the armed mid-day renders, the year over (line gate on and off, with the night\'s backup leg and without, three modes): byte-identical to v1.205.0 but for the one correction — each "no force-charge carries it" note and the backup leg\'s log line worded by its own leg\'s line — which moves only renders naming a line in [49.00, 50.00]; counted', () => {
  const hash = createHash('sha256');
  let renders = 0;
  const moved = { renders: 0, records: 0, nights: new Set<string>(), byNote: { 'this leg': 0, 'the backup leg': 0, 'backup log': 0 } as Record<string, number>, lines: [] as number[] };
  const named = new Set<string>();
  const errs: string[] = [];
  const add = (s: string): void => { hash.update(`${undo(s)}\n`); renders++; };
  for (const c of CASES.filter((x) => / 21:30$/.test(x.label))) for (const b of ['np', 'm'] as const) for (let h = 4; h <= 20; h++) {
    const on = planAt(c.label, b, h, true);
    const off = planAt(c.label, b, h, false);
    // The gate-off night's armed and advisory 21:30 push (RN-2 hashes the gate-on night's).
    for (const m of [buildNightChargeMessage(off, off.chargeTonight ? 'charge' : 'hold', SUP as never), buildNightChargeMessage(off, off.chargeTonight ? 'charge' : 'hold', null)]) {
      add(m.title);
      add(m.body);
    }
    for (const [gate, p, withBackup] of [['on', on, true], ['off', off, false], ['off', off, true]] as const) for (const mode of ['supervised', 'auto', 'advisory'] as const) {
      const where = `${c.label} ${b} ${h} h, gate ${gate}${withBackup ? ', backup' : ''}, ${mode}`;
      const raw: MiddayShadowRecord = {
        version: 1, day: '2026-10-14', computedAtMs: phx(10, 14, 21, 30), why: 'midday', mode,
        backup: withBackup ? summariseLeg(BACKUP_LEG, { plan: off, windowPvP50Kwh: null, windowLoadP50Kwh: null }, armOf(mode)) : null,
        cost: summariseLeg(COST_LEG, { plan: p, windowPvP50Kwh: null, windowLoadP50Kwh: null }, armOf(mode)),
        refresh: null, note: null,
      };
      const rec = coerceMiddayShadowRecord(JSON.parse(JSON.stringify(raw)))!;
      const i = middayShadowAnnounceInput(rec, MODEL)!;
      if (i.refused != null) errs.push(`${where}: refused`);
      const push = buildMiddayPlanMessage(i);
      const texts = [push.title, push.body, ...middayShadowLogLines(rec)];
      const lineOf = (which: string): number | null => (which === 'this leg' ? rec.cost!.cushionLineSocPct : rec.backup?.cushionLineSocPct ?? null);
      // Each note worded by its own leg's line.
      for (const [, over, which] of push.body.matchAll(NOTE)) {
        if (over !== lineOverReserveText(lineOf(which) ?? Infinity, 'accepts')) errs.push(`${where}: ${which} (line ${lineOf(which)}) is above "${over}"`);
      }
      for (const t of texts.slice(2)) for (const [, over] of t.matchAll(LOG)) {
        if (over !== lineOverReserveText(lineOf('the backup leg') ?? Infinity, 'accepts')) errs.push(`${where}: backup log (line ${lineOf('the backup leg')}) is above "${over}"`);
      }
      let any = false;
      for (const [k, t] of texts.entries()) {
        add(t);
        if (undo(t) === t) continue;
        any = true;
        moved.renders++;
        const note = k >= 2 ? 'backup log' : t.includes(`${OVER_HELD} and no force-charge carries it on this leg`) ? 'this leg' : 'the backup leg';
        moved.byNote[note]++;
        const l = lineOf(note === 'this leg' ? 'this leg' : 'the backup leg');
        if (l == null || l > 50) errs.push(`${where}: ${note} moved on a line of ${l}`);
        else moved.lines.push(l);
        if (/^2026-11-25 21:30 np 11 h, gate off, backup/.test(where) && note !== 'this leg' && l === 50) named.add('2026-11-25 np 11 h backup 50.00');
        if (/^2027-08-31 21:30 m 7 h, gate off/.test(where) && note === 'this leg' && l === 49) named.add('2027-08-31 m 7 h this leg 49.00');
      }
      if (any) { moved.records++; moved.nights.add(where.replace(/, (supervised|auto|advisory)$/, '')); }
    }
  }
  // v1.205.0's renders, with the one correction undone: captured at 8e8c13f4 (where `undo` changes nothing).
  assert.deepEqual({ renders, sha256: hash.digest('hex') }, PIN_V1205, 'every armed render byte-identical to v1.205.0 but for the correction');
  assert.deepEqual(errs.slice(0, 5), [], `${errs.length} errors`);
  assert.deepEqual({
    renders: moved.renders, records: moved.records, configurations: moved.nights.size, byNote: moved.byNote,
    lines: { min: Math.min(...moved.lines), max: Math.max(...moved.lines) },
  }, PIN_MOVED);
  assert.deepEqual([...named].sort(), ['2026-11-25 np 11 h backup 50.00', '2027-08-31 m 7 h this leg 49.00']);
});
