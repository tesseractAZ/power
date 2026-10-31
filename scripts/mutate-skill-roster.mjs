#!/usr/bin/env node
/**
 * mutate-skill-roster.mjs — v1.196.0: the forecast-skill hindcast measures each past day on that
 * day's recorded Cores.
 *
 * WHY COMMITTED. The scorer inferred each past day's pool membership from the telemetry it was
 * checking. v1.94.0 read "no rows yet" as "had not joined yet", which is also what a blackout
 * already running when the window began gives, so the dark Core's missing share was scored as a
 * forecast miss (+50% a day with one of three Cores dark, +200% with two). And today's Cores were
 * applied to 30 days of history, so a Core in the pool then but on the bench today was left out of
 * the actual: with a dark Core exempted as well, 2026-08-11..08-19 read 184-258% phantom misses,
 * the PV band calibrator saturated and the night-charge basis gate closed (72% < 78%). Each mutant
 * restores one part of that, or breaks one part of what replaced it:
 *
 *   Coverage    C-i..C-v     (no rows is a gap; the Cores a day is measured on; a named SN with
 *                             no series)
 *   Roster      R-i..R-ix    (off-roster is not scored; additions pause; a swap day; the record's
 *                             start; the production reader; the predecessor's PV; a stand-in day
 *                             the record cannot vouch for)
 *   Record      M-i..M-viii  (the blip fold; the entry in force at the day's start; a superset
 *                             pool; the like-for-like swap; the holder is a member; the
 *                             confirmation stamp's reach)
 *   Slots       S-i..S-vii   (the recorder writes the slot table; a legacy entry gains it; a
 *                             rearrangement is no membership change; only connected sources; only
 *                             a fresh panel reading confirms)
 *
 *   node scripts/mutate-skill-roster.mjs [--only <id prefix>]
 *
 * ★ Every mutation is ANCHOR-ASSERTED: if `find` is not present exactly once the harness ABORTS.
 * ★ Each mutant runs in its own copy of the tree (scripts/lib/mutateParallel.mjs).
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMutantsParallel } from './lib/mutateParallel.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const AN = resolve(REPO, 'server/src/analytics.ts');
const MH = resolve(REPO, 'server/src/membershipHistory.ts');
const SM = resolve(REPO, 'server/src/shp2Membership.ts');
const REC = resolve(REPO, 'server/src/recorder.ts');

const SUBSET = [
  'test/skillRoster.test.ts',
  'test/pvCoverageGate.test.ts',
  'test/darkCoreCoverage.test.ts',
  'test/membershipHistory.test.ts',
  'test/skillCacheForecastBound.test.ts',
  'test/realizedGhiStage2.test.ts',
];

const MUTANTS = [
  // ── Coverage ──────────────────────────────────────────────────────────────
  {
    id: 'C-i. ★ a Core with no readings on a day is exempt (the v1.94.0 signature)',
    file: AN,
    find: '      if (frac < minFrac) covered = false;',
    to: '      if (frac < minFrac && frac > 0) covered = false; /* MUTANT */',
    why: 'A Core dark when the window began, or one returning days after the others, has its missing share scored as a forecast miss: +50% a day with one of three Cores dark, +200% with two.',
  },
  {
    id: 'C-ii. ★ coverage is judged on every series fetched, not on the Cores the day is measured on',
    file: AN,
    find: '    for (const sn of coresOn ? coresOn(dayStart) : presentBySn.keys()) {',
    to: '    for (const sn of presentBySn.keys()) { /* MUTANT */',
    why: 'A departed Core fetched for the days before a swap is required on the days after it too: every day after a swap reads as a gap and the window empties.',
  },
  {
    id: 'C-iii. the skill passes no Cores to the coverage gate',
    file: AN,
    find: '  const dayCoverage = coreCoverageByDay(ghiByEpoch, pvBySn, todayStart, windowDays, PV_COVERAGE_MIN_FRAC, coresOn);',
    to: '  const dayCoverage = coreCoverageByDay(ghiByEpoch, pvBySn, todayStart, windowDays, PV_COVERAGE_MIN_FRAC); /* MUTANT */',
    why: 'The pure gate is right and the production call ignores it: a swap empties the window again.',
  },
  {
    id: 'C-iv. a named Core with no series at all is skipped',
    file: AN,
    find: '      const present = presentBySn.get(sn);',
    to: '      const present = presentBySn.get(sn); if (!present) continue; /* MUTANT */',
    why: 'A Core the day is measured on with nothing recorded passes as covered: absence read as success.',
  },
  {
    id: 'C-v. ★ a day before a swap has its coverage judged on today\'s Cores, its actual on that day\'s',
    file: AN,
    find: '  const dayCoverage = coreCoverageByDay(ghiByEpoch, pvBySn, todayStart, windowDays, PV_COVERAGE_MIN_FRAC, coresOn);',
    to: '  const dayCoverage = coreCoverageByDay(ghiByEpoch, pvBySn, todayStart, windowDays, PV_COVERAGE_MIN_FRAC, () => dpuSns); /* MUTANT */',
    why: 'The incoming Core\'s bench rows pass coverage for a day on which the departed Core it stands for recorded nothing: that Core\'s share is scored as a miss (+50% on the fixture).',
  },
  // ── Roster ────────────────────────────────────────────────────────────────
  {
    id: 'R-i. ★ off-roster days are scored',
    file: AN,
    find: "    const offRoster = rosterVerdict === 'off-roster';",
    to: '    const offRoster = false; /* MUTANT */',
    why: 'A day whose pool lacked an array the model expects (before a Core was added) is scored on the incoming Core\'s bench rows against the model\'s three arrays: +25% a day on the fixture.',
  },
  {
    id: 'R-ii. an off-roster day carries an error percentage',
    file: AN,
    find: '    const errPct = weatherCovered && !coverageGap && !offRoster && actKwh > 0.5 ? Math.round((errKwh / actKwh) * 1000) / 10 : null;',
    to: '    const errPct = weatherCovered && !coverageGap && actKwh > 0.5 ? Math.round((errKwh / actKwh) * 1000) / 10 : null; /* MUTANT */',
    why: 'The PV band calibrator and forecastDayR2 key on errorPct != null: the off-roster day reaches the band.',
  },
  {
    id: 'R-iii. off-roster days feed MAE and the bias factor',
    file: AN,
    find: '    if (offRoster) continue;',
    to: '    /* MUTANT */',
    why: 'The day shows null but still drags the bias factor and the MAE.',
  },
  {
    id: 'R-iv. ★ an ADDITION is scored like a stable day (no pause)',
    file: AN,
    find: "    if (cores == null) out.set(dayStart, { verdict: 'off-roster', sns: model });",
    to: "    if (cores == null) out.set(dayStart, { verdict: 'on-roster', sns: model }); /* MUTANT */",
    why: 'The days before a Core joined through an empty slot are scored on its bench rows (or its silence) against a model fitted on one more array.',
  },
  {
    id: 'R-v. a day whose Cores changed during the day is scored',
    file: AN,
    find: "      if (c == null || (cores != null && c.join(',') !== cores.join(','))) { cores = null; break; }",
    to: '      if (c == null) { cores = null; break; } /* MUTANT */',
    why: 'The swap day is measured on the new Cores all day, the incoming Core\'s bench hours included.',
  },
  {
    id: 'R-vi. days before the record fail closed',
    file: AN,
    find: "    if (inForce == null) { out.set(dayStart, { verdict: 'unrecorded', sns: model }); continue; }",
    to: "    if (inForce == null) { out.set(dayStart, { verdict: 'off-roster', sns: model }); continue; } /* MUTANT */",
    why: 'A fresh install or a lost record scores nothing for 30 days, and the night-charge basis gate stays shut.',
  },
  {
    id: 'R-vii. ★ the production reader is not wired',
    file: AN,
    find: '  const history = membership === undefined ? curtailmentMembershipHistory() : membership;',
    to: '  const history = membership ?? null; /* MUTANT */',
    why: 'The pure roster is right and the band calibrator never reads the record: every day is "unrecorded" and today\'s Cores are applied to 30 days of history again.',
  },
  {
    id: 'R-viii. ★ a day before a swap is measured on today\'s Cores, not that day\'s',
    file: AN,
    find: "    return r?.verdict === 'predecessor' ? r.sns : dpuSns;",
    to: '    return dpuSns; /* MUTANT */',
    why: 'The incoming Core\'s bench rows stand for the departed Core\'s array: +25% a day on the fixture.',
  },
  {
    id: 'R-ix. ★ a stand-in day the record cannot vouch for is scored',
    file: AN,
    find: "    else if (!(history && membershipConfirmedDuring(history, dayStart, siteShiftDaysMs(dayStart, 1)))) out.set(dayStart, { verdict: 'off-roster', sns: model });",
    to: '    /* MUTANT */',
    why: 'A swap made while the panel was cloud-offline is still recorded as the old Cores: the departed Core\'s bench rows (0 W) are scored as its array, +50% a day.',
  },
  // ── Record ────────────────────────────────────────────────────────────────
  {
    id: 'M-i. ★ the blip fold is off',
    file: MH,
    find: '    if (i > 0 && next != null && next.atMs - e.atMs < glitchMs) continue; // a flicker',
    to: '    /* MUTANT */',
    why: 'A one-poll isConnect flicker takes the whole day off the roster.',
  },
  {
    id: 'M-ii. ★ the membership in force at the day\'s start is dropped',
    file: MH,
    find: '    if (end > fromMs && kept[i].atMs < toMs) out.push(kept[i]);',
    to: '    if (kept[i].atMs >= fromMs && kept[i].atMs < toMs) out.push(kept[i]); /* MUTANT */',
    why: 'Every day without a change has no membership in force and reads off-roster: the window empties.',
  },
  {
    id: 'M-iii. a pool with more Cores than the model is off-roster',
    file: MH,
    find: "  const pool = new Set(entry.fp.split(','));",
    to: "  const pool = new Set(entry.fp.split(',')); if (pool.size !== modelSns.length) return null; /* MUTANT */",
    why: 'Removing a Core from the pool pauses the skill for weeks although the model\'s Cores were all there.',
  },
  {
    id: 'M-iv. ★ a like-for-like swap is treated as an addition',
    file: MH,
    find: '    out.add(held);',
    to: '    return null; /* MUTANT */',
    why: 'A Core swapped into a slot (it takes over the departing Core\'s array) closes the night-charge basis gate until 14 days on the new Cores are scored.',
  },
  {
    id: 'M-v. a slot holder outside the pool stands in',
    file: MH,
    find: '    if (held == null || !pool.has(held) || modelSns.includes(held) || out.has(held)) return null;',
    to: '    if (held == null || modelSns.includes(held) || out.has(held)) return null; /* MUTANT */',
    why: 'An inconsistent record (a slot map naming a Core the pool did not hold) measures a day on a Core that was not there.',
  },
  {
    id: 'M-vi. latestSlotOf reads the oldest slot map',
    file: MH,
    find: '  for (let i = h.entries.length - 1; i >= 0 && out.size < sns.length; i--) {',
    to: '  for (let i = 0; i < h.entries.length && out.size < sns.length; i++) { /* MUTANT */',
    why: 'A Core that changed slots is matched by its old slot: the day is measured on the wrong predecessor.',
  },
  {
    id: 'M-vii. ★ a stamp vouches for any stretch after it',
    file: MH,
    find: '    if (stamp == null || stamp + slackMs < Math.min(end, toMs)) return false;',
    to: '    if (stamp == null) return false; /* MUTANT */',
    why: 'One fresh reading before the panel went dark vouches for the whole dark stretch: a swap inside it is scored on the departed Core.',
  },
  {
    id: 'M-viii. a folded flicker drops its return\'s stamp',
    file: MH,
    find: '      if (e.confirmedMs != null && (prev.confirmedMs == null || e.confirmedMs > prev.confirmedMs)) merged.confirmedMs = e.confirmedMs;',
    to: '      /* MUTANT */',
    why: 'Every stand-in day after a one-poll flicker reads unconfirmed: the like-for-like swap pauses the skill again.',
  },
  // ── Slots ─────────────────────────────────────────────────────────────────
  {
    id: 'S-i. ★ the recorder writes no slot table',
    file: REC,
    find: '    if (recordMembership(membershipHistory, membershipFp, now, connectedSlotMap(snap.devices), panelsFresh)) {',
    to: '    if (recordMembership(membershipHistory, membershipFp, now, undefined, panelsFresh)) { /* MUTANT */',
    why: 'Every swap is recorded as membership alone and reads as an addition: the scoring pause after every swap.',
  },
  {
    id: 'S-ii. an entry recorded before slot maps never gains one',
    file: MH,
    find: '      last.slots = { ...s };',
    to: '    /* MUTANT */',
    why: 'On the installed plant the current entry predates slot maps: the first swap after the update pauses the skill.',
  },
  {
    id: 'S-iii. the same Cores in other slots append a membership change',
    file: MH,
    find: '  if (last != null && last.fp === fp) {',
    to: '  if (last != null && last.fp === fp && s == null) { /* MUTANT */',
    why: 'Every rollup appends an entry: the 64-entry record is gone in five hours, and membershipVerdict reads every day as changed (the curtailment freeze, the pack-DC RTE).',
  },
  {
    id: 'S-iv. a disconnected source is recorded in a slot',
    file: SM,
    find: '      if (src.isConnected && src.sn && Number.isInteger(src.slot)) out[`${panel.sn}:${src.slot}`] = src.sn;',
    to: '      if (src.sn && Number.isInteger(src.slot)) out[`${panel.sn}:${src.slot}`] = src.sn; /* MUTANT */',
    why: 'A Core listed but not connected is recorded as holding the slot: a day it was not in the pool is measured on it.',
  },
  {
    id: 'S-v. ★ the recorder confirms the membership from a frozen panel',
    file: REC,
    find: '    const panelsFresh = allShp2s(snap.devices).every((panel) => shp2ReadbackFresh(panel, now));',
    to: '    const panelsFresh = true; /* MUTANT */',
    why: 'A cloud-offline panel\'s kept projection confirms the Cores of before through the dark stretch: a swap inside it is scored on the departed Core.',
  },
  {
    id: 'S-vi. a fresh reading never moves the stamp',
    file: MH,
    find: '    if (confirmed && (last.confirmedMs == null || atMs - last.confirmedMs >= MEMBERSHIP_CONFIRM_STEP_MS)) {',
    to: '    if (false) { /* MUTANT */',
    why: 'An entry is confirmed only at the moment it was appended: every stand-in day reads unconfirmed and a like-for-like swap pauses the skill.',
  },
  {
    id: 'S-vii. the stamp moves on every rollup',
    file: MH,
    find: '    if (confirmed && (last.confirmedMs == null || atMs - last.confirmedMs >= MEMBERSHIP_CONFIRM_STEP_MS)) {',
    to: '    if (confirmed) { /* MUTANT */',
    why: 'membership-history.json is rewritten every 5 min.',
  },
];

await runMutantsParallel({ name: 'mutate-skill-roster', mutants: MUTANTS, subset: SUBSET, root: REPO });
