#!/usr/bin/env node
/**
 * mutate-zero-cushion.mjs — committed mutation harness for v1.133.0's
 * deliberate-zero outage cushion.
 *
 * WHY COMMITTED: the defect this replaces was INERT CONFIGURATION — an owner set
 * the cushion to 0, the option was accepted, validation passed, and the setting
 * silently delivered the legacy 15%-of-pool band instead. Worse, the legacy basis
 * also switches the cushion test to the whole-house forward trough, so asking for
 * NO cushion made the requirement LARGER. Nothing failed; the decision just did
 * not happen. That failure mode leaves no trace, so the guards have to be proven.
 *
 *   node scripts/mutate-zero-cushion.mjs
 *
 * ★ Every mutation is ANCHOR-ASSERTED: if `find` is not present exactly once the
 *   harness ABORTS rather than reporting a green run against an unmutated tree.
 * ★ Mutates the working tree in place, restoring in a finally block. Do not run
 *   git add/commit/checkout while it is running.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = resolve(REPO, 'server');
const ADVISOR = resolve(SERVER, 'src/nightChargeAdvisor.ts');
const ACTUATOR = resolve(SERVER, 'src/nightChargeActuator.ts');
// v1.191.0 — the reserve write envelope is a hardware fact in hwSpec.ts (nightChargeActuator re-exports it).
const HWSPEC = resolve(SERVER, 'src/hwSpec.ts');

const SUBSET = ['test/zeroCushion.test.ts', 'test/cushionRescope.test.ts', 'test/nightChargeEvContention.test.ts'];

const MUTANTS = [
  {
    id: 'i. ★ zero folds back into the unmeasurable branch (the shipped defect)',
    file: ADVISOR,
    find: "  if (outageHours === 0) return { kwh: 0, basis: 'disabled' };",
    to: '  /* MUTANT */',
    why: 'This IS the defect: asking for no cushion silently delivers the legacy 15% band and a harsher trough test.',
  },
  {
    id: 'ii. the disabled check moves AFTER the unmeasurable branch',
    file: ADVISOR,
    find: "  if (outageHours === 0) return { kwh: 0, basis: 'disabled' };\n\n  if (\n    islandedLoadKw == null",
    to: "  if (\n    islandedLoadKw == null",
    why: 'Ordering is the fix: with no islanded-load reading, a deliberate zero would fall through to the legacy band.',
  },
  {
    id: 'iii. a malformed hours value is treated as a decision',
    file: ADVISOR,
    find: '  if (outageHours === 0) return',
    to: '  if (outageHours <= 0) return', // eslint-disable-line -- MUTANT
    why: 'A negative or garbage hours value would silently disable the cushion instead of failing conservative.',
  },
  {
    id: 'iv. ★ the disabled cushion stops announcing itself',
    file: ADVISOR,
    find: "    ? `the ${reserveFloorPct}% reserve floor alone — the outage cushion is DISABLED, so nothing is held back for an outage`",
    to: "    ? `the ${reserveFloorPct}% floor+cushion` /* MUTANT */",
    why: 'A night with NO outage margin would read as one whose cushion was comfortably covered — the standard lowered, reported as met.',
  },
  {
    id: 'v. the disabled basis takes the whole-house trough',
    file: ADVISOR,
    find: "    if (cushionBasis === 'legacy-pct' || backupLeg) return houseTroughAtLift(lift);",
    to: "    if (cushionBasis !== 'islanded-outage' || backupLeg) return houseTroughAtLift(lift); /* MUTANT */",
    why: 'Disabling the cushion would apply the HARSHER whole-house test, raising the requirement instead of lowering it.',
  },
  {
    id: 'vii. ★ the announced reserve goes back to the un-clamped setpoint',
    file: ADVISOR,
    find: '  const writtenPct = clampReserveTarget(setpointSocPct);',
    to: '  const writtenPct = setpointSocPct; /* MUTANT */',
    why: 'This IS the shipped over-promise: the 21:30 notification and the SPOKEN broadcast said "the reserve is set to 100%" while the panel was told 50.',
  },
  {
    id: 'viii. the truncation disclosure is dropped',
    file: ADVISOR,
    find: '  const truncated = setpointSocPct > writtenPct + 0.05;',
    to: '  const truncated = false; /* MUTANT */',
    why: 'The operator would hear a correct 50% with no hint that the requirement was 75% and got cut — a true number that hides the shortfall.',
  },
  {
    id: 'ix. the write envelope constant is widened',
    file: HWSPEC,
    find: 'export const RESERVE_WRITE_MAX_PCT = 50;',
    to: 'export const RESERVE_WRITE_MAX_PCT = 100; /* MUTANT */',
    why: 'The announced reserve would exceed what the panel accepts — proven on 2026-09-16, when a 90 write settled at 50 — so the 21:30 notification and the spoken broadcast would promise a reserve the device will not hold, and clampReserveTarget would stop clamping.',
  },
  {
    id: 'vi. a disabled cushion reports a non-zero kWh',
    file: ADVISOR,
    find: "  if (outageHours === 0) return { kwh: 0, basis: 'disabled' };",
    to: "  if (outageHours === 0) return { kwh: legacyCushionKwh, basis: 'disabled' }; /* MUTANT */",
    why: 'The basis would say disabled while the number still reserved 13.8 kWh — the two halves disagreeing is how this hid.',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs);
// the verdict procedure per mutant (subset, then the full suite on a subset pass) is unchanged.
import { runMutantsParallel } from './lib/mutateParallel.mjs';
await runMutantsParallel({ name: 'mutate-zero-cushion', mutants: MUTANTS, subset: SUBSET, root: REPO });
