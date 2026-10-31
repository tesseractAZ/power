#!/usr/bin/env node
/**
 * mutate-held-panel-load.mjs — v1.195.0: the house runway's live-load rung reads a panel reading only
 * while it IS one, and the runway alarm holds its state while the house runway is unavailable.
 *
 * Since v1.188.1 a held panel (a cloud replay, a stalled feed) writes no panel_load rows, so a hold
 * empties the runway's hour window and lands in its live-load rung, which summed the held circuits as
 * the live load and re-stamped the carry clock on every compute: a frozen 600 W hid a 6 kW house, a
 * frozen 9 kW raised a false HIGH, and the v1.175.0 carry limit never came due. The rung now takes the
 * recorder's own gate (heldSamples.projectionRecordable), and an unavailable house runway holds the
 * alarm's latch instead of re-arming it, and the load-shed advisor's last advisory instead of calling
 * the runway healthy.
 *
 *   Gate   G-i..G-v   (the gate itself, its stand-ins, the carry stamp, the freshness window)
 *   Alarm  A-i..A-iii (unavailable holds the alarm and the load-shed advice; never "healthy")
 *
 *   node scripts/mutate-held-panel-load.mjs [--only <id prefix>]
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const AN = resolve(REPO, 'server/src/analytics.ts');
const RA = resolve(REPO, 'server/src/runwayAlarm.ts');
const LS = resolve(REPO, 'server/src/loadShedAdvisor.ts');
const SUBSET = [
  'test/runwayHeldPanelLoad.test.ts',
  'test/runwayTrough.test.ts',
  'test/runwayLoadCarry.test.ts',
  'test/runwayAlarm.test.ts',
  'test/loadShed.test.ts',
  'test/loadShedGridAware.test.ts',
];

const MUTANTS = [
  /* ── the gate on the live channel sum ── */
  {
    id: 'G-i. ★★★ the live channel sum is taken with no gate (v1.192.0)',
    file: AN,
    find: '    const liveLoadWatts = projectionRecordable(shp2, now)',
    to: '    const liveLoadWatts = true /* MUTANT */',
    why: 'Held circuits are the house load: 600 W hides a 6 kW draw, 9 kW raises a false HIGH.',
  },
  {
    id: 'G-ii. ★★★ the gate is the cloud\'s online flag',
    file: AN,
    find: 'projectionRecordable(shp2, now)\n',
    to: 'shp2.online === true /* MUTANT */\n',
    why: 'A panel listed online through a replay or a stalled feed passes: its frozen circuits are the load.',
  },
  {
    id: 'G-iii. ★★ the cloud-shadow latch is ignored',
    file: AN,
    find: 'projectionRecordable(shp2, now)\n',
    to: 'projectionRecordable({ ...shp2, contentStaleSinceMs: null }, now) /* MUTANT */\n',
    why: 'A REST replay of the cached body bumps the arrival clock and counts as a reading.',
  },
  {
    id: 'G-iv. ★★★ the carry clock is stamped from the raw sum',
    file: AN,
    find: '    if (liveLoadWatts > 0) runwayLoadMeasuredAtMs = now;',
    to: '    if ((shp2.projection.circuits ?? []).some((c) => (c.watts ?? 0) > 0)) runwayLoadMeasuredAtMs = now; /* MUTANT */',
    why: 'Every compute re-dates the last real load: the carry never expires during a hold.',
  },
  {
    id: 'G-v. ★★ the freshness window is widened',
    file: AN,
    find: 'projectionRecordable(shp2, now)\n',
    to: 'projectionRecordable(shp2, now, 6 * 3_600_000) /* MUTANT */\n',
    why: 'A feed stopped minutes ago still reads as the live load for six hours.',
  },
  /* ── the alarm across an unavailable runway ── */
  {
    id: 'A-i. ★★★ an unavailable house runway re-arms the alarm (v1.192.0)',
    file: RA,
    find: '      if (p.unavailable != null) return;',
    to: '      /* MUTANT */',
    why: 'A data outage reads as a recovery: the latch clears, the reminder stops, a blip re-announces.',
  },
  {
    id: 'A-ii. ★★ an unavailable house runway clears the load-shed recommendation',
    file: LS,
    find: '      if (runway.unavailable != null && lastAvailable != null) return lastAvailable;',
    to: '      /* MUTANT */',
    why: 'Two hours into a panel hold load_shed_recommended turns false mid-depletion; an automation gated on it restores the shed loads.',
  },
  {
    id: 'A-iii. ★ an unavailable runway is called healthy',
    file: LS,
    find: "  if (unavailable != null) return 'Runway projection unavailable — no shed recommended.';",
    to: '  /* MUTANT */',
    why: 'A restart into a hold reports "Runway healthy" with no projection behind it.',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs).
// fullSuite: false — the subset holds every test that guards these mutants.
import { runMutantsParallel } from './lib/mutateParallel.mjs';
// typecheck: true — a mutant that does not compile is reported INVALID, never counted as a kill.
await runMutantsParallel({ name: 'mutate-held-panel-load', mutants: MUTANTS, subset: SUBSET, root: REPO, fullSuite: false, typecheck: true });
