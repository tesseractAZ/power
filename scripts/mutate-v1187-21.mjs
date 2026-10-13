#!/usr/bin/env node
/**
 * mutate-v1187-21.mjs — v1.187.21: a peer cell-spread outlier at WARNING is pushed and carded,
 * never announced (audible:false at any SoC); the critical line and the other peer metrics speak.
 *
 *   P-i    the cell-spread warning loses its audible:false (the 2026-10-12 18:31:59 yellow returns)
 *   P-ii   audible:false is applied to every peer metric at warning (a hot pack goes quiet)
 *   P-iii  the cell-spread warning drops the push instead of the audible (annunciate:false)
 *   P-iv   the audible:false holds only at the top of charge again (the v1.187.0 gate)
 *   P-v    the card no longer says a cell-spread warning is pushed, not announced
 *   P-vi   the cell-spread CRITICAL (vdiff-crit) is made non-audible
 *
 *   node scripts/mutate-v1187-21.mjs
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const AN = resolve(REPO, 'server/src/analytics.ts');
const AL = resolve(REPO, 'server/src/alerts.ts');
const SUBSET = [
  'test/peerSpreadPushedNotAnnounced.test.ts',
  'test/peerSpreadTopOfChargeAudible.test.ts',
  'test/peerSpreadYieldsToHeldCritical.test.ts',
];

const MUTANTS = [
  {
    id: 'P-i. ★★★ the cell-spread warning loses its audible:false',
    file: AN,
    find: '          ...(spreadWarning ? { audible: false } : {}), // v1.187.21 — see spreadWarning above.',
    to: '          /* MUTANT */',
    why: 'An evening discharge speaks a yellow for a warning-level cell spread that is push-only on the pack itself (2026-10-12 18:31:59).',
  },
  {
    id: 'P-ii. ★★★ audible:false is applied to every peer metric at warning',
    file: AN,
    find: "        const spreadWarning = metric.key === 'voldiff' && severity === 'warning';",
    to: "        const spreadWarning = severity === 'warning'; /* MUTANT */",
    why: 'A pack running hotter than its siblings, or a worn or stranded pack, is never announced.',
  },
  {
    id: 'P-iii. ★★★ the cell-spread warning drops the push instead of the audible',
    file: AN,
    find: '          ...(spreadWarning ? { audible: false } : {}), // v1.187.21 — see spreadWarning above.',
    to: '          ...(spreadWarning ? { annunciate: false } : {}), /* MUTANT */',
    why: 'A diverging pack below the critical line is neither spoken nor pushed — the backstop v1.45.0 relies on is gone.',
  },
  {
    id: 'P-iv. ★★ the audible:false holds only at the top of charge again',
    file: AN,
    find: "        const spreadWarning = metric.key === 'voldiff' && severity === 'warning';",
    to: "        const spreadWarning = metric.key === 'voldiff' && severity === 'warning' && (pk.soc ?? d.projection.soc ?? 0) >= 95; /* MUTANT */",
    why: 'The v1.187.20 shape: the outlier speaks below the 95% line, as it did on 2026-10-12 at 64% SoC.',
  },
  {
    id: 'P-v. ★ the card no longer says a cell-spread warning is pushed, not announced',
    file: AN,
    find: "${spreadWarning ? ' Cell-spread warnings are pushed, not announced; a cell imbalance at the critical line is announced.' : ''}",
    to: '',
    why: 'The card gives no reason a warning on screen and on the phone was never heard.',
  },
  {
    id: 'P-vi. ★★★ the cell-spread CRITICAL is made non-audible',
    file: AL,
    find: '            ...(critMute ? { annunciate: false, mutedBy: critMute, muteReason: CELL_SPREAD_MUTE_TEXT[critMute] } : {}),',
    to: '            ...(critMute ? { annunciate: false, mutedBy: critMute, muteReason: CELL_SPREAD_MUTE_TEXT[critMute] } : {}),\n            audible: false, /* MUTANT */',
    why: 'With both warning reports push-only, a spread at the critical line would reach no speaker at all.',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs).
// fullSuite: false — the subset holds every test that guards these mutants, so a kill comes
// from the subset.
import { runMutantsParallel } from './lib/mutateParallel.mjs';
// typecheck: true — a mutant that does not compile is reported INVALID, never counted as a kill.
await runMutantsParallel({ name: 'mutate-v1187-21', mutants: MUTANTS, subset: SUBSET, root: REPO, fullSuite: false, typecheck: true });
