#!/usr/bin/env node
/**
 * mutate-force-charge-on.mjs — committed harness for v1.186.0: the force-charge ON is verified
 * by device readback (re-issued once, then warned about), never ahead of the OFF and never on
 * a stale readback.
 *
 *   node scripts/mutate-force-charge-on.mjs
 *
 * ★ Anchor-asserted; a red subset baseline aborts; restores in a finally block and on
 *   SIGINT/SIGTERM/SIGHUP; refuses to start over a leftover mutant marker.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = resolve(REPO, 'server');
const FC = resolve(SERVER, 'src/nightForceCharge.ts');
const ACT = resolve(SERVER, 'src/nightChargeActuator.ts');
const INDEX = resolve(SERVER, 'src/index.ts');
const CMD = resolve(SERVER, 'src/ecoflow/commands.ts');

const SUBSET = ['test/forceChargeOn.test.ts', 'test/edges.test.ts'];

const MUTANTS = [
  {
    id: 'i. ★★★ the ON verify runs AHEAD of the OFF triggers',
    file: FC,
    find: '    if (reason) return { kind: \'off\', slots: ours, reason };\n',
    to: '    { const v = verifyForceChargeOn(s, nowMs, o, ours); if (v.kind !== \'none\') return v; } /* MUTANT */\n    if (reason) return { kind: \'off\', slots: ours, reason };\n',
    why: 'An unapplied ON at 05:00 re-issues ON instead of switching OFF — the window-end OFF is delayed.',
  },
  {
    id: 'ii. ★★★ a stale readback counts as "every slot OFF"',
    file: FC,
    find: '  if (o.slotsOn == null) return { kind: \'none\' };\n',
    to: '  if (o.slotsOn == null) o = { ...o, slotsOn: [] }; /* MUTANT */\n',
    why: 'A cloud-dark panel re-issues ON and then warns "did not take effect" on no evidence at all.',
  },
  {
    id: 'iii. ★★ no readback grace before a slot counts as not-taken',
    file: FC,
    find: '  if (since < FORCE_CHARGE_ON_VERIFY_AFTER_MS) return { kind: \'none\' };',
    to: '  /* MUTANT */',
    why: 'The re-issue fires the tick after the ON, inside the 5-min per-slot cooldown — spent rate-limited.',
  },
  {
    id: 'iv. ★★★ the at-the-ceiling exemption is gone',
    file: FC,
    find: 'Number.isFinite(soc) && soc >= ceiling;',
    to: 'Number.isFinite(soc) && soc >= ceiling && false; /* MUTANT */',
    why: 'A slot the panel switched off itself (its Core at the ceiling) is re-issued and reported as a failure.',
  },
  {
    id: 'v. ★★★ the re-issue skips the start\'s grid and vitals gates',
    file: FC,
    find: '    if (o.gridPresent !== true || o.vitalsRed) return { kind: \'none\' };',
    to: '    /* MUTANT */',
    why: 'A grid charge is re-started with the grid unknown, or from a process whose vitals are critical.',
  },
  {
    id: 'vi. ★★★ the ON is re-issued forever — the warning never goes',
    file: FC,
    find: '  if (s.forceChargeOnRetries < FORCE_CHARGE_ON_MAX_RETRIES) {',
    to: '  if (true) { /* MUTANT */',
    why: 'An ON the panel ignores is re-sent every 6 min all night, and the forfeited buy is never reported.',
  },
  {
    id: 'vii. ★★ the warning repeats every tick',
    file: FC,
    find: '  if (s.forceChargeOnFailedAtMs != null) return { kind: \'none\' };',
    to: '  /* MUTANT */',
    why: 'The "did not take effect" warning and push fire every minute until the window closes.',
  },
  {
    id: 'viii. ★★★ the check is not one-shot — a verified ON is re-judged',
    file: FC,
    find: '  if (s.forceChargeOnVerifiedAtMs != null) return { kind: \'none\' };',
    to: '  /* MUTANT */',
    why: 'The panel switching ch1 off at its ceiling (04:19 on 09-23) re-issues ON and warns falsely.',
  },
  {
    id: 'ix. ★★ the failure marker is lost on a restart',
    file: ACT,
    find: '    forceChargeOnFailedAtMs: num(o.forceChargeOnFailedAtMs),',
    to: '    forceChargeOnFailedAtMs: null, /* MUTANT */',
    why: 'Every restart after the warning sends it again.',
  },
  {
    id: 'x. ★★★ the integrator never spends the re-issue',
    file: INDEX,
    find: '      forceChargeOnRetries: nightActuationMem.forceChargeOnRetries + 1,',
    to: '      forceChargeOnRetries: nightActuationMem.forceChargeOnRetries, /* MUTANT */',
    why: 'decideForceCharge keeps returning onRetry; the warning is unreachable in production.',
  },
  {
    id: 'xi. ★★★ the ON is re-issued right up to the window end',
    file: FC,
    find: '    if (s.windowEndMs == null || nowMs >= s.windowEndMs - FORCE_CHARGE_ON_RETRY_CUTOFF_MS) {',
    to: '    if (false) { /* MUTANT */',
    why: 'A re-issue at WE-2 takes the slot\'s cooldown; the window-end OFF comes back rate-limited and it grid-charges past the close.',
  },
  {
    id: 'xii. ★★★ an implausible ceiling readback (a reconnect 0) is trusted',
    file: FC,
    find: '  if (rb == null || !Number.isFinite(rb) || rb < FORCE_CHARGE_CEILING_MIN_PCT || rb > FORCE_CHARGE_CEILING_MAX_PCT) return synced;',
    to: '  if (rb == null) return synced; /* MUTANT */',
    why: 'Every slot counts as at-ceiling: a permanent, silent false ON VERIFIED on a buy that never happened.',
  },
  {
    id: 'xiii. ★★ an all-exempt verdict with no slot reading ON',
    file: FC,
    find: '  if (notOn.length === 0 && anyOn) {',
    to: '  if (notOn.length === 0) { /* MUTANT */',
    why: 'A bad all-at-ceiling reading with nothing ON stamps VERIFIED; no re-issue, no warning.',
  },
  {
    id: 'xiv. ★★★ an OFF shares the cooldown an ON took',
    file: CMD,
    find: '  const key = req.on ? action : `${action}-off`;',
    to: '  const key = action; /* MUTANT */',
    why: 'The window-end, target or grid-loss OFF right after a re-issue comes back rate-limited.',
  },
  {
    id: 'xv. ★★ an OFF no longer holds off a following ON',
    file: CMD,
    find: '  if (allowed && !req.on) rateLimitState.set(`${action}|${req.sn}`, Date.now());',
    to: '  /* MUTANT */',
    why: 'An ON can be written seconds after an OFF on the same slot — the cooldown no longer spaces the pair.',
  },
  {
    id: 'xvi. ★★★ the ON-verify grace runs from the stamp BEFORE the write loop',
    file: INDEX,
    find: '    persistNightActuation({ ...nightActuationMem, forceChargeOnLastAttemptMs: Date.now() });',
    to: '    /* MUTANT */',
    why: 'Slow PUTs land the one re-issue inside a later slot\'s cooldown; it is spent rate-limited and the warning is false.',
  },
  {
    id: 'xvii. ★★ the re-issue grace is not re-stamped after its writes',
    file: INDEX,
    find: '      forceChargeOnLastAttemptMs: Date.now(),',
    to: '      /* MUTANT */',
    why: 'The warning grace is measured from before slow retry writes, not from when they finished.',
  },
  {
    id: 'xviii. ★★ a wholly rate-limited re-issue is still spent',
    file: INDEX,
    find: '    const unspent = limited === action.slots.length;',
    to: '    const unspent = false; /* MUTANT */',
    why: 'A re-issue that never reached the panel counts; the warning says "after 1 re-issue(s)" falsely.',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs);
// the verdict procedure per mutant (subset, then the full suite on a subset pass) is unchanged.
import { runMutantsParallel } from './lib/mutateParallel.mjs';
await runMutantsParallel({ name: 'mutate-force-charge-on', mutants: MUTANTS, subset: SUBSET, root: REPO });
