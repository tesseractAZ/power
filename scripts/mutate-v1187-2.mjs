#!/usr/bin/env node
/**
 * mutate-v1187-2.mjs — committed harness for v1.187.2: the knee SESSION across the whole plateau,
 * and a seeded critical-line clock that ends on any reading under 50 mV until a reading confirms it.
 *
 * (1) Between VOL_DIFF_PLATEAU_SOC_PCT (85%) and the 95% quiet line no session clock (graceFromMs)
 * ran, so the episode clock (critSinceMs) was the balancing mute's only bound there, and a dip under
 * the plateau line of VDIFF_KNEE_RELAX_MS or more ends it: a balancing spread at 95 / 45 / 45 mV on
 * a ~180 s BMS cadence, 95 / 45 mV with a missed reading, or 95 / 70 / 70 mV restarted the 20-minute
 * bound on every crossing and was never announced. advanceVdiffKnee now runs the session across the
 * plateau: it starts on the first crossing there, ends on a reading below it or after a seen
 * VDIFF_KNEE_MAX_MUTE_MS rest under 50 mV on it; the spoken note names the plateau line below the
 * top of charge. Mutants i-viii and xxii-xxiii here; the rest's scope on the plateau and an unknown SoC
 * starting a rest are covered by mutate-v1187-a.mjs lix-lxi (re-pointed).
 *
 * (2) The seeded-clock reset (v1.187.1) applied only to the first reading after a restart
 * (prev.lastSeenMs null): a first reading at 50-89 mV on the plateau carried a day-old onset through
 * the readings under 50 mV after it for VDIFF_KNEE_RELAX_MS, and a benign crossing in that window
 * annunciated at once. A critSeeded mark (set by vdiffKneeSeed, cleared by a reading at the line and
 * whenever critSinceMs is cleared) now gates the reset, and is written to the knee-session file with
 * the clock and restored with it: written without it, a second restart restored the day-old onset as
 * a clock a process saw; written as none (this release's first draft, caught in review), a second
 * quick restart lost the clock outright — the onset is pruned on the first tick back. Mutants ix-xxi;
 * xix-xxi pin the invariant critSeeded ⇒ critSinceMs, which no alarm reads (killed by the
 * state-machine tests only). The reset dropped outright, and a reset on any reading under the
 * plateau line, are mutate-v1187-1.mjs xxxix-xl (re-pointed).
 *
 *   node scripts/mutate-v1187-2.mjs
 *
 * ★ Anchor-asserted (each anchor matches exactly once); every mutant must TYPECHECK (one that does
 *   not is reported INVALID, never counted as killed); a red baseline (typecheck or subset) aborts,
 *   and so does a red full suite before it is used to count a kill; each kill prints the tests that
 *   failed; restores in a finally block and on SIGINT/SIGTERM/SIGHUP; refuses to start over a
 *   leftover mutant marker.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = resolve(REPO, 'server');
const AL = resolve(SERVER, 'src/alerts.ts');

const SUBSET = [
  'test/cellSpreadPlateauSession.test.ts',
  'test/cellSpreadKneeRestart.test.ts',
  'test/cellSpreadKneeSessionRestart.test.ts',
  'test/cellSpreadKneeSessionMonitor.test.ts',
  'test/cellSpreadEndOfChargeKnee.test.ts',
  'test/cellSpreadPolicyMuteHold.test.ts',
  'test/alertVdiffBalancing.test.ts',
];

const MUTANTS = [
  /* ── (1) the session across the plateau ───────────────────────────────────────────────── */
  {
    id: 'i. ★★★ a reading below the top of charge ends the session again (v1.187.1)',
    file: AL,
    find: '  if (obs.packSoc != null && obs.packSoc < VOL_DIFF_PLATEAU_SOC_PCT) {',
    to: '  if (obs.packSoc != null && obs.packSoc < VOL_DIFF_PLATEAU_QUIET_SOC_PCT) { /* MUTANT */',
    why: 'Between 85% and 95% a balancing 95 / 45 / 45 mV spread restarts the 20-minute bound on every crossing: never announced.',
  },
  {
    id: 'ii. ★★★ the session starts only at the top of charge',
    file: AL,
    find: '    if (onPlateau && obs.spreadMv >= vdiffCritMvFor(obs.packSoc)) s.graceFromMs ??= s.critSinceMs ?? nowMs;',
    to: '    if (topOfCharge && obs.spreadMv >= vdiffCritMvFor(obs.packSoc)) s.graceFromMs ??= s.critSinceMs ?? nowMs; /* MUTANT */',
    why: 'As i: below 95% no session ever starts, and hi / lo / lo, a missed reading or hi / 70 / 70 is muted with no limit.',
  },
  {
    id: 'iii. ★★★ the balancing mute honours the session only at the top of charge',
    file: AL,
    find: "    return s.graceFromMs != null && nowMs - s.graceFromMs >= VDIFF_KNEE_MAX_MUTE_MS ? null : 'balancing';",
    to: "    return s.graceFromMs != null && (obs.packSoc == null || obs.packSoc >= VOL_DIFF_PLATEAU_QUIET_SOC_PCT) && nowMs - s.graceFromMs >= VDIFF_KNEE_MAX_MUTE_MS ? null : 'balancing'; /* MUTANT */",
    why: 'The session runs at 90% but bounds nothing there: the same silence on the mute side.',
  },
  {
    id: 'iv. ★★ the plateau\'s own line (85%) ends the session',
    file: AL,
    find: '  if (obs.packSoc != null && obs.packSoc < VOL_DIFF_PLATEAU_SOC_PCT) {',
    to: '  if (obs.packSoc != null && obs.packSoc <= VOL_DIFF_PLATEAU_SOC_PCT) { /* MUTANT */',
    why: 'At exactly 85% — on the plateau, its critical line 90 mV — the session is cleared on every reading and hi / lo / lo goes unannounced.',
  },
  {
    id: 'v. ★★ the rest runs only at the top of charge',
    file: AL,
    find: '    else if (onPlateau) s.quietSinceMs ??= nowMs;',
    to: '    else if (topOfCharge) s.quietSinceMs ??= nowMs; /* MUTANT */',
    why: 'A benign crossing at 90% that relaxes for 20 minutes keeps its session until the pack leaves the plateau: the next benign crossing there sounds.',
  },
  {
    id: 'vi. ★★ an unknown SoC starts a session',
    file: AL,
    find: '    if (onPlateau && obs.spreadMv >= vdiffCritMvFor(obs.packSoc)) s.graceFromMs ??= s.critSinceMs ?? nowMs;',
    to: '    if (obs.spreadMv >= vdiffCritMvFor(obs.packSoc)) s.graceFromMs ??= s.critSinceMs ?? nowMs; /* MUTANT */',
    why: 'A reading with no SoC (off the plateau, its line 50 mV) opens a session that only a reading below 85% or a rest can end.',
  },
  {
    id: 'vii. ★ the note names the top of charge below it',
    file: AL,
    find: "            ? 'at this top of charge' : `above ${VOL_DIFF_PLATEAU_SOC_PCT}% charge`;",
    to: "            ? 'at this top of charge' : 'at this top of charge'; /* MUTANT */",
    why: 'A pack at 90% is announced as "at this top of charge".',
  },
  {
    id: 'viii. ★ the note names the plateau at the top of charge',
    file: AL,
    find: "            ? 'at this top of charge' : `above ${VOL_DIFF_PLATEAU_SOC_PCT}% charge`;",
    to: "            ? `above ${VOL_DIFF_PLATEAU_SOC_PCT}% charge` : `above ${VOL_DIFF_PLATEAU_SOC_PCT}% charge`; /* MUTANT */",
    why: 'The top-of-charge wording the operator already knows is lost.',
  },
  /* ── (2) the seeded critical-line clock ───────────────────────────────────────────────── */
  {
    id: 'ix. ★★★ the seeded reset applies only to the first reading after the restart again (v1.187.1)',
    file: AL,
    find: '    if ((s.critSeeded && obs.spreadMv < VOL_DIFF_CRIT_MV) || nowMs - s.belowCritSinceMs >= VDIFF_KNEE_RELAX_MS) {',
    to: '    if ((prev?.lastSeenMs == null && obs.spreadMv < VOL_DIFF_CRIT_MV) || nowMs - s.belowCritSinceMs >= VDIFF_KNEE_RELAX_MS) { /* MUTANT */',
    why: 'A day-old onset whose first reading back is 70 mV rides the next 30 mV readings: a benign crossing inside five minutes sounds the red klaxon.',
  },
  {
    id: 'x. ★★★ the seed is not marked',
    file: AL,
    find: '    critSeeded: true,',
    to: '    critSeeded: false, /* MUTANT */',
    why: 'A seeded clock is treated as one the process saw: a reading under 50 mV never ends it, and the next day\'s benign knee sounds.',
  },
  {
    id: 'xi. ★★ a reading at the line does not confirm the seed',
    file: AL,
    find: '    s.critSinceMs ??= nowMs;\n    s.belowCritSinceMs = null;\n    s.critSeeded = false;\n',
    to: '    s.critSinceMs ??= nowMs;\n    s.belowCritSinceMs = null; /* MUTANT */\n',
    why: 'A critical still standing when the add-on returns loses its old onset on its first dip under 50 mV: its episode clock restarts.',
  },
  {
    id: 'xii. ★★★ the seed\'s mark is not written to the knee-session file',
    file: AL,
    // v1.195.0 — re-pointed: the off-plateau session's fields follow the mark in the entry.
    find: '      ...(st.critSeeded ? { critSeeded: true as const } : {}),\n      // v1.195.0 — the off-plateau session',
    to: '      /* MUTANT */\n      // v1.195.0 — the off-plateau session',
    why: 'A second restart restores a day-old onset as a clock a process saw: a reading under 50 mV no longer ends it, and a benign crossing sounds the red klaxon.',
  },
  {
    id: 'xiii. ★★★ an unconfirmed seed is written as none (the first draft of this release)',
    file: AL,
    find: '      packSn: st.packSn, critSinceMs: st.critSinceMs, graceFromMs: st.graceFromMs,',
    to: '      packSn: st.packSn, critSinceMs: st.critSeeded ? null : st.critSinceMs, graceFromMs: st.graceFromMs, /* MUTANT */',
    why: 'A second quick restart finds neither the clock nor the onset (pruned on the first tick back): the fault the onset named opens a fresh 20-minute mute.',
  },
  {
    id: 'xiv. ★ a change of mark alone is not written (the file states what the process holds)',
    file: AL,
    find: '    if ((d?.critSeeded === true) !== st.critSeeded) changed = true;',
    to: '    /* MUTANT */',
    // The mark alone changes only when graceFromMs == critSinceMs (both from the seed), so the
    // session bound covers the same mutes and no alarm reads the stale mark: file hygiene.
    why: 'A seed confirmed at the line (its session seeded with it) stays marked on file until another value changes.',
  },
  {
    id: 'xv. ★★★ the restore drops the mark',
    file: AL,
    find: '      critSeeded: s.critSinceMs != null && s.critSeeded === true,',
    to: '      critSeeded: false, /* MUTANT */',
    why: 'As xii, on the restore side.',
  },
  {
    id: 'xvi. ★★ the restore marks every restored clock as a seed',
    file: AL,
    find: '      critSeeded: s.critSinceMs != null && s.critSeeded === true,',
    to: '      critSeeded: s.critSinceMs != null, /* MUTANT */',
    why: 'A restart on a 45 mV reading of the 90% balancing fault ends the episode the file carried.',
  },
  {
    id: 'xvii. ★ the restore keeps a mark with no clock',
    file: AL,
    find: '      critSeeded: s.critSinceMs != null && s.critSeeded === true,',
    to: '      critSeeded: s.critSeeded === true, /* MUTANT */',
    why: 'A corrupt entry plants a mark the invariant critSeeded ⇒ critSinceMs forbids (written back to the file).',
  },
  {
    id: 'xviii. ★ a mark that is not a boolean is trusted',
    file: AL,
    find: "  if (!(o.critSeeded === undefined || typeof o.critSeeded === 'boolean')) return null;",
    to: '  /* MUTANT */',
    why: 'A corrupt entry is restored as a confirmed clock instead of being skipped and counted.',
  },
  {
    id: 'xix. ★ invariant — leaving the plateau keeps the mark',
    file: AL,
    find: '    s.critSinceMs = null;\n    s.belowCritSinceMs = null;\n    s.critSeeded = false;\n  } else if',
    to: '    s.critSinceMs = null;\n    s.belowCritSinceMs = null; /* MUTANT */\n  } else if',
    why: 'critSeeded outlives its clock (no alarm reads it then; a later reader of the mark would).',
  },
  {
    id: 'xx. ★ invariant — the reset keeps the mark',
    file: AL,
    find: '      s.belowCritSinceMs = null;\n      s.critSeeded = false;\n    }',
    to: '      s.belowCritSinceMs = null; /* MUTANT */\n    }',
    why: 'As xix.',
  },
  {
    id: 'xxi. ★ invariant — a fresh state is marked',
    file: AL,
    // v1.195.0 — re-pointed: the fresh state's literal goes on with the off-plateau session's fields.
    find: 'lastSeenMs: nowMs, critSeeded: false,\n',
    to: 'lastSeenMs: nowMs, critSeeded: true, /* MUTANT */\n',
    why: 'As xix: a state with no clock carries the mark.',
  },
  /* ── (1, review) the note's boundaries ──────────────────────────────────────────────────── */
  {
    id: 'xxii. ★ the top-of-charge wording starts above 95%',
    file: AL,
    find: '          const sessionWhere = packSoc != null && packSoc >= VOL_DIFF_PLATEAU_QUIET_SOC_PCT',
    to: '          const sessionWhere = packSoc != null && packSoc > VOL_DIFF_PLATEAU_QUIET_SOC_PCT /* MUTANT */',
    why: 'A pack at exactly 95% — the top of charge, where both graces apply — is announced "above 85% charge".',
  },
  {
    id: 'xxiii. ★ a reading with no SoC takes the top-of-charge wording',
    file: AL,
    find: '          const sessionWhere = packSoc != null && packSoc >= VOL_DIFF_PLATEAU_QUIET_SOC_PCT',
    to: '          const sessionWhere = (packSoc == null || packSoc >= VOL_DIFF_PLATEAU_QUIET_SOC_PCT) /* MUTANT */',
    why: 'With no SoC nothing says the pack is at the top of charge; the session only says it began on the plateau.',
  },
];

// Built with join() on purpose: check-mutant-anchors.mjs reads a path.resolve call on SERVER
// with a single string literal as a mutant TARGET file, and CI's checkout has no node_modules.
// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs);
// the verdict procedure per mutant is unchanged.
import { runMutantsParallel } from './lib/mutateParallel.mjs';
await runMutantsParallel({ name: 'mutate-v1187-2', mutants: MUTANTS, subset: SUBSET, root: REPO, typecheck: true });
