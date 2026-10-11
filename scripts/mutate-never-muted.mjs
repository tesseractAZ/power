#!/usr/bin/env node
/**
 * mutate-never-muted.mjs — committed harness for `isNeverMutedAlert`
 * (server/src/alerts.ts) and the bench-spare stamp that honours it.
 *
 * WHY COMMITTED: this predicate is the ONLY thing standing between "bench
 * hardware stops chiming" (v1.95.0, desirable) and "the one battery that is
 * actually broken is the one you are never paged about" — the severity
 * inversion the 2026-08-20 pack swap produced. Both of its branches, and the
 * exemption inside the spare stamp, must be demonstrably load-bearing.
 *
 *   node scripts/mutate-never-muted.mjs
 *
 * ★ Anchor-asserted; restores in finally; do not touch the tree while running.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = resolve(REPO, 'server');
const MOD = resolve(SERVER, 'src/alerts.ts');
const SUBSET = ['test/defectivePackAlert.test.ts', 'test/offPanelAnnunciation.test.ts', 'test/defectivePackLatch.test.ts'];

const MUTANTS = [
  {
    id: 'i. ★ defective-pack exemption removed — the broken battery goes silent again',
    find: "  return a.id.startsWith('pack-defective-');",
    to: '  return false; /* MUTANT */',
    why: 'Restores the exact severity inversion: the RMA pack mute-by-location while its healthy replacement pages.',
  },
  {
    id: 'ii. ★ thermal-critical exemption removed',
    find: "  if (a.severity === 'critical' && a.category === 'Thermal') return true;",
    to: '  /* MUTANT */',
    why: 'An overheating pack on the bench would stop paging.',
  },
  {
    id: 'iii. exemption widened to ALL thermal, not just critical',
    find: "  if (a.severity === 'critical' && a.category === 'Thermal') return true;",
    to: "  if (a.category === 'Thermal') return true; /* MUTANT */",
    why: 'Routine warm-MPPT chatter from bench hardware would page the operator — the noise v1.95.0 removed.',
  },
  {
    id: 'iv. ★ spare stamp ignores the exemption (bench stamp re-mutes everything)',
    find: '        if (isNeverMutedAlert(out[i])) continue;',
    to: '        /* MUTANT */',
    why: 'The alerts.ts bench stamp would re-mute the defective-pack alert before alertMonitor ever sees it.',
  },
  {
    id: 'v. ★ deviant-cell leg dropped (a latched but cell-matched pack reports a phantom deviant cell)',
    find: '      const defectiveLegsLive = dLatch != null && dFx != null && Math.abs(dFx.deltaMv) >= DEFECTIVE_PACK_MIN_DEVIANT_MV;',
    to: '      const defectiveLegsLive = dLatch != null && dFx != null; /* MUTANT */',
    why: 'packCellForensics names a deviant cell even on a matched pack, so the alert would claim "0 mV from the pack median".',
  },
  {
    id: 'vi. ★ latch leg dropped (any pack with a deviant cell is called defective)',
    find: '      const defectiveLegsLive = dLatch != null && dFx != null && Math.abs(dFx.deltaMv) >= DEFECTIVE_PACK_MIN_DEVIANT_MV;',
    to: '      const defectiveLegsLive = dFx != null && Math.abs(dFx.deltaMv) >= DEFECTIVE_PACK_MIN_DEVIANT_MV; /* MUTANT */',
    why: 'A healthy pack at the low-SoC knee would be declared defective and page the operator.',
  },
  {
    id: 'vii. ★ LATCH quiescent emission dropped — the 08-24 flap returns',
    find: '      } else if (dConfirmed) {',
    to: '      } else if (false && dConfirmed) { /* MUTANT */',
    why: 'The alert resolves the moment a charge burst ends and re-pushes [High] on the next one — 3 push/resolve pairs in one day.',
  },
  {
    id: 'viii. ★ confirmation never recorded — the latch is inert',
    find: '        if (defectiveLegsLive) {\n          confirmDefectivePack({',
    to: '        if (false && defectiveLegsLive) { /* MUTANT */\n          confirmDefectivePack({',
    why: 'With nothing ever confirmed, the quiescent branch is unreachable and behavior silently reverts to the flapping v1.101.0.',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs);
// the verdict procedure per mutant (subset, then the full suite on a subset pass) is unchanged.
import { runMutantsParallel } from './lib/mutateParallel.mjs';
await runMutantsParallel({ name: 'mutate-never-muted', mutants: MUTANTS.map((m) => ({ file: MOD, ...m })), subset: SUBSET, root: REPO });
