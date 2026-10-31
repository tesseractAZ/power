#!/usr/bin/env node
/**
 * mutate-cell-spread-off-plateau.mjs — v1.195.0: the cell-spread critical below the plateau.
 *
 * (A) The balancing mute had no limit below 85% SoC or with no SoC: the v1.187.0-.2 bounds run only on
 * the plateau and are cleared below it. A critical below the plateau now opens an off-plateau session
 * (offFromMs) that dips under the line do not end and only 20 minutes seen under 50 mV does; every
 * mute there ends VDIFF_KNEE_MAX_MUTE_MS after its first crossing, carried across a gap and a restart.
 * (B) A 50-149 mV spread on a pack at 15% or less, within 10 points of its siblings, is held on the
 * card (not pushed, not sounded) for at most those 20 minutes; stranded packs, sessions that reached
 * the line on any other reading, and 150 mV page at once.
 *
 *   Session  O-i..O-vii   (the bound, its fail-closed default, the rest, the carry, the persist, the start,
 *                          a crossing breaking the rest)
 *   Knee     K-i..K-vi    (the peer gate, the SoC line, the forfeit, its use, the sibling median, the own SoC)
 *   Restart  R-i..R-v     (the restored clock, the coherent rest, the onset seed, the persisted mark, the
 *                          change test)
 *
 *   node scripts/mutate-cell-spread-off-plateau.mjs [--only <id prefix>]
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const AL = resolve(REPO, 'server/src/alerts.ts');
const SUBSET = [
  'test/cellSpreadOffPlateauSession.test.ts',
  'test/cellSpreadEndOfChargeKnee.test.ts',
  'test/cellSpreadKneeRestart.test.ts',
  'test/cellSpreadKneeSessionRestart.test.ts',
  'test/cellSpreadPlateauSession.test.ts',
  'test/alertVdiffBalancing.test.ts',
];

const MUTANTS = [
  /* ── (A) the off-plateau session ── */
  {
    id: 'O-i. ★★★ no bound below the plateau (v1.192.0)',
    file: AL,
    find: '  if (!onPlateau && (s.offFromMs == null || nowMs - s.offFromMs >= VDIFF_KNEE_MAX_MUTE_MS)) return null;',
    to: '  /* MUTANT */',
    why: 'A balancing spread at 60% is silent for as long as the BMS balances; a low-charge spread forever.',
  },
  {
    id: 'O-ii. ★★★ no session reads as no bound (fails open)',
    file: AL,
    find: '(s.offFromMs == null || nowMs - s.offFromMs',
    to: '(s.offFromMs != null && nowMs - s.offFromMs /* MUTANT */',
    why: 'A state with no off-plateau clock — hand-built, or from before v1.195.0 — mutes with no limit.',
  },
  {
    id: 'O-iii. ★★★ a six-minute dip is a rest',
    file: AL,
    find: '    if (nowMs - s.offQuietSinceMs >= VDIFF_KNEE_MAX_MUTE_MS) {',
    to: '    if (nowMs - s.offQuietSinceMs >= VDIFF_KNEE_RELAX_MS) { /* MUTANT */',
    why: '55 / 45 / 45 mV on the BMS cadence opens a new session on every 55: never announced.',
  },
  {
    id: 'O-iv. ★★★ a reading gap drops the off-plateau session',
    file: AL,
    find: '    if ((st.critSinceMs == null && st.graceFromMs == null && st.offFromMs == null) || st.lastSeenMs == null || now - st.lastSeenMs > VDIFF_KNEE_GAP_CARRY_MS) vdiffKneeByKey.delete(k);',
    to: '    if ((st.critSinceMs == null && st.graceFromMs == null) || st.lastSeenMs == null || now - st.lastSeenMs > VDIFF_KNEE_GAP_CARRY_MS) vdiffKneeByKey.delete(k); /* MUTANT */',
    why: 'An offline blip every few minutes restarts the 20-minute bound: a balancing fault below 85% never speaks.',
  },
  {
    id: 'O-v. ★★★ the off-plateau session is not written to the knee-session file',
    file: AL,
    find: '      ...(st.offFromMs != null ? { offFromMs: st.offFromMs } : {}),',
    to: '      /* MUTANT */',
    why: 'An auto-update at minute 15 buys 20 more minutes of balancing silence below the plateau.',
  },
  {
    id: 'O-vi. ★ an on-plateau reading opens the off-plateau session',
    file: AL,
    find: '    else if (!onPlateau) { s.offFromMs = nowMs; s.offKnee = lowKnee; }',
    to: '    else { s.offFromMs = nowMs; s.offKnee = lowKnee; } /* MUTANT */',
    why: 'A top-of-charge knee starts a clock that later bounds an unrelated mid-charge spread (fail loud, false red).',
  },
  {
    id: 'O-vii. ★★★ a reading at the line no longer breaks the rest',
    file: AL,
    find: '    s.offQuietSinceMs = null;\n    if (s.offFromMs != null) { if (!lowKnee) s.offKnee = false; }',
    to: '    /* MUTANT */\n    if (s.offFromMs != null) { if (!lowKnee) s.offKnee = false; }',
    why: '55 / 45 / 45 mV: the six-minute dips add up to a 20-minute "rest" that ends the session at +23, and every 55 mV run after it opens a fresh, muted one.',
  },
  /* ── (B) the low-charge knee ── */
  {
    id: 'K-i. ★★★ a stranded pack gets the low-charge grace',
    file: AL,
    find: '    && obs.siblingMedianSoc != null && obs.siblingMedianSoc - obs.packSoc < VOL_DIFF_LOW_KNEE_PEER_PTS;',
    to: '    ; /* MUTANT */',
    why: 'The warranty-pack shape (11% against siblings at 59%) is held for 20 minutes instead of paging.',
  },
  {
    id: 'K-ii. ★★ the SoC line is exclusive',
    file: AL,
    find: 'obs.packSoc <= VOL_DIFF_LOW_KNEE_SOC_PCT',
    to: 'obs.packSoc < VOL_DIFF_LOW_KNEE_SOC_PCT /* MUTANT */',
    why: 'A pack at exactly 15% sounds red at the bottom of a healthy discharge.',
  },
  {
    id: 'K-iii. ★★★ no forfeit: a reading that is not the knee keeps the grace',
    file: AL,
    find: '    if (s.offFromMs != null) { if (!lowKnee) s.offKnee = false; }',
    to: '    if (s.offFromMs != null) { /* MUTANT */ }',
    why: 'A session that read 16% or stranded at the line goes back to silence on its next 12% reading.',
  },
  {
    id: 'K-iv. ★★★ the grace ignores the session\'s mark',
    file: AL,
    find: "  if (!onPlateau) return s.offKnee === true && lowChargeKnee(obs) ? 'low-charge' : null;",
    to: "  if (!onPlateau) return lowChargeKnee(obs) ? 'low-charge' : null; /* MUTANT */",
    why: 'A spread that reached the line at 40% is held once the pack reaches 12%.',
  },
  {
    id: 'K-v. ★★ the sibling median counts the pack itself',
    file: AL,
    find: 'upperMedianSoc(p.packs.filter((x) => x.num !== pk.num && x.soc != null)',
    to: 'upperMedianSoc(p.packs.filter((x) => x.soc != null) /* MUTANT */',
    why: 'A pack with one sibling is "within 10 points" of itself; the stranded note names the wrong median.',
  },
  {
    id: 'K-vi. ★★ the knee reads the device SoC when the pack reports none',
    file: AL,
    find: '        const siblingMedianSoc = pk.soc != null\n',
    to: '        const siblingMedianSoc = true /* MUTANT */\n',
    why: 'A pack with no SoC of its own is graced on the Core\'s average, which says nothing about how it sits against its siblings.',
  },
  /* ── across a restart ── */
  {
    id: 'R-i. ★★★ the restore drops the off-plateau clock',
    file: AL,
    find: '      offFromMs: s.offFromMs == null ? null : Math.min(s.offFromMs, nowMs),',
    to: '      offFromMs: null, /* MUTANT */',
    why: 'Written but never read back: every restart restarts the bound below the plateau.',
  },
  {
    id: 'R-ii. ★★ an incoherent off-plateau rest is restored',
    file: AL,
    find: '      && vdiffKneeOffRestCoherent(s);',
    to: '      && true; /* MUTANT */',
    why: 'A rest dated before its session (a corrupt file) ends the running session on the first quiet reading.',
  },
  {
    id: 'R-iii. ★★ the onset does not seed the off-plateau session',
    file: AL,
    find: '    offFromMs: nowMs - at <= VDIFF_KNEE_GAP_CARRY_MS ? at : null, offQuietSinceMs: null, offKnee: false,',
    to: '    offFromMs: null, offQuietSinceMs: null, offKnee: false, /* MUTANT */',
    why: 'With the file lost, a restart during a balancing-held critical below 85% restarts its 20 minutes.',
  },
  {
    id: 'R-iv. ★★ the low-charge mark is not written to the knee-session file',
    file: AL,
    find: '      ...(st.offFromMs != null && st.offKnee === true ? { offKnee: true as const } : {}),',
    to: '      /* MUTANT */',
    why: 'A restart in the middle of a low-charge knee sounds the critical red at once, against the card-only treatment.',
  },
  {
    id: 'R-v. ★★★ a change to the off-plateau fields alone is not written',
    file: AL,
    find: '    if ((d?.offFromMs ?? null) !== (next[key].offFromMs ?? null) || (d?.offQuietSinceMs ?? null) !== (next[key].offQuietSinceMs ?? null)\n      || (d?.offKnee === true) !== (next[key].offKnee === true)) changed = true;',
    to: '    /* MUTANT */',
    why: 'A forfeit inside one persist grain stays unwritten: a restart hands the low-charge grace back to a session that lost it.',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs).
// fullSuite: false — the subset holds every test that guards these mutants.
import { runMutantsParallel } from './lib/mutateParallel.mjs';
// typecheck: true — a mutant that does not compile is reported INVALID, never counted as a kill.
await runMutantsParallel({ name: 'mutate-cell-spread-off-plateau', mutants: MUTANTS, subset: SUBSET, root: REPO, fullSuite: false, typecheck: true });
