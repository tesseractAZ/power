#!/usr/bin/env node
/**
 * mutate-heal-idle-quorum.mjs — committed mutation harness for the v1.157.0 self-heal
 * quorum membership rule (server/src/sessionSelfHeal.ts `selfHealQuorum`, wired in
 * server/src/index.ts's rate-floor tick).
 *
 * WHY COMMITTED: the heal budget is shared by every device and is the only route to
 * rebuilding the session under the alarm-path panel. On 2026-09-13 three Cores whose
 * collapses surfaced while discharging went idle at reserve, stayed held (an idle Core
 * cannot clear the recovery bar), and kept a quorum that spent four heals on a healthy
 * session. Each mutant restores that defect or breaks what the fix must keep: the panel's
 * identity exception, heals for active hardware, and an alert set nobody filtered.
 *
 *   node scripts/mutate-heal-idle-quorum.mjs
 *
 * ★ Every anchor is pre-flighted before any test runs; a red subset baseline aborts, and
 *   the full-suite fallback is baselined (once, lazily) before it may count a kill.
 * ★ A test run that could not START (spawn or buffer failure) aborts — it is never
 *   counted as a kill.
 * ★ Mutates the working tree in place and restores it in a finally block; SIGINT/SIGTERM/
 *   SIGHUP restore and exit. It refuses to start if a target already carries a mutant
 *   marker. Do not run git add/commit/checkout while it is running.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = resolve(REPO, 'server');
const HEAL = resolve(SERVER, 'src/sessionSelfHeal.ts');
const INDEX = resolve(SERVER, 'src/index.ts');

const SUBSET = [
  'test/selfHealIdleQuorum.test.ts',
  'test/sessionSelfHeal.test.ts',
  'test/rosterAwareSpares.test.ts',
];

const MUTANTS = [
  // ── the membership rule ───────────────────────────────────────────────────
  {
    id: 'i. ★★★ every surfaced collapse votes again (the 09-13 defect)',
    file: HEAL,
    find: '    if (alarmPathSns.has(c.sn) || !idleSns.has(c.sn)) counted.push(member);',
    to: '    if (true /* MUTANT */) counted.push(member);',
    why: 'Idle Cores held at reserve refill the quorum hourly and spend the budget the panel needs.',
  },
  {
    id: 'ii. ★★ the panel is idle-filtered like any Core (identity guard dropped)',
    file: HEAL,
    find: '    if (alarmPathSns.has(c.sn) || !idleSns.has(c.sn)) counted.push(member);',
    to: '    if (!idleSns.has(c.sn) /* MUTANT */) counted.push(member);',
    why: 'The alarm chain\'s input loses its heal vote the day its projection gains power fields that read idle.',
  },
  {
    id: 'iii. ★★ only the panel ever counts (overcorrection)',
    file: HEAL,
    find: '    if (alarmPathSns.has(c.sn) || !idleSns.has(c.sn)) counted.push(member);',
    to: '    if (alarmPathSns.has(c.sn) /* MUTANT */) counted.push(member);',
    why: 'A genuine session wedge on Cores that are moving power could never be healed.',
  },
  {
    id: 'iv. ★ the count ignores the filter',
    file: HEAL,
    find: '  return { count: counted.length, counted, idleExcluded };',
    to: '  return { count: surfaced.length /* MUTANT */, counted, idleExcluded };',
    why: 'The log names the right voters while the decision still counts the idle ones.',
  },
  {
    id: 'v. ★★ the panel exception is removed from the heal decision',
    file: HEAL,
    find: '  const quorumMet = starvedCount >= cfg.minStarvedDevices || opts?.alarmCriticalStarved === true;',
    to: '  const quorumMet = starvedCount >= cfg.minStarvedDevices; /* MUTANT */',
    why: 'With idle Cores no longer voting, a panel-only wedge (09-14 21:22) can never start the heal clock.',
  },
  // ── the production wiring ─────────────────────────────────────────────────
  {
    id: 'vi. ★★★ the tick passes every surfaced collapse again',
    file: INDEX,
    find: '      now, healQuorum.count, selfHealState, DEFAULT_SELF_HEAL_CONFIG, { alarmCriticalStarved },',
    to: '      now, collapses.length /* MUTANT */, selfHealState, DEFAULT_SELF_HEAL_CONFIG, { alarmCriticalStarved },',
    why: 'selfHealQuorum is computed, logged and ignored; production burns the budget exactly as before.',
  },
  {
    id: 'vii. ★★ idle membership is never recorded',
    file: INDEX,
    find: '        if (idle) idleSurfacedSns.add(sn);',
    to: '        /* MUTANT: idle add deleted */',
    why: 'The idle set is always empty, so every held Core votes.',
  },
  {
    id: 'viii. ★ every surfaced device is recorded as idle',
    file: INDEX,
    find: '        if (idle) idleSurfacedSns.add(sn);',
    to: '        idleSurfacedSns.add(sn); /* MUTANT */',
    why: 'Only the panel can ever start a heal; an active Core wedge is abandoned.',
  },
  {
    id: 'ix. ★★ the idle filter leaks into the ALERT set',
    file: INDEX,
    find: '      if (dec.surfaced) {\n        surfacedCollapses.add(sn);',
    to: '      if (dec.surfaced && !idle) { /* MUTANT */\n        surfacedCollapses.add(sn);',
    why: 'Held collapses silently resolve when a Core idles and re-page when it wakes — the v1.111.0 flap, reintroduced.',
  },
  {
    id: 'x. the alarm-path exception reads the filtered set',
    file: INDEX,
    find: '    const alarmCriticalStarved = alarmPathSns.size > 0 && collapses.some((c) => alarmPathSns.has(c.sn));',
    to: '    const alarmCriticalStarved = alarmPathSns.size > 0 && collapses.some((c) => alarmPathSns.has(c.sn) && !idleSurfacedSns.has(c.sn)); /* MUTANT */',
    why: 'The panel exception starts depending on the panel\'s power data instead of its identity.',
  },
  {
    id: 'xi. ★★ the call site drops the panel exception',
    file: INDEX,
    find: '      now, healQuorum.count, selfHealState, DEFAULT_SELF_HEAL_CONFIG, { alarmCriticalStarved },',
    to: '      now, healQuorum.count, selfHealState, DEFAULT_SELF_HEAL_CONFIG, /* MUTANT: exception dropped */',
    why: 'The pure exception survives but production never passes it: a panel-only wedge (09-14 19:59, 21:42) can never start the heal clock.',
  },
  {
    id: 'xii. heals stop naming their voters',
    file: INDEX,
    find: "      app.log.warn(`self-heal: ${healVerdict.reason} [counted: ${healQuorum.counted.map((m) => m.deviceName).join(', ')}]`);",
    to: '      app.log.warn(`self-heal: ${healVerdict.reason}`); /* MUTANT */',
    why: 'Which devices drove a rebuild has to be reconstructed from collapse and recovery lines again.',
  },
  // ── the idle-exclusion log ────────────────────────────────────────────────
  {
    id: 'xiii. ★ the tick logs the raw exclusion list (every tick)',
    file: INDEX,
    find: '    for (const m of idleExclusionEdges(healIdleExcluded, healQuorum.idleExcluded)) {',
    to: '    for (const m of healQuorum.idleExcluded) { /* MUTANT */',
    why: 'Three idle Cores write ~1,700 identical lines a night and bury the heal trail.',
  },
  {
    id: 'xiv. the exclusion line is demoted to debug',
    file: INDEX,
    find: '      app.log.info(`self-heal: ${m.deviceName} no longer counts toward the heal quorum',
    to: '      app.log.debug(/* MUTANT */ `self-heal: ${m.deviceName} no longer counts toward the heal quorum',
    why: 'On an install at the default info level the only visible proof that a device lost its vote disappears.',
  },
  {
    id: 'xv. ★ an excluded device is reported again every tick (edge guard removed)',
    file: HEAL,
    find: '    if (logged.has(m.sn)) continue;',
    to: '    /* MUTANT: edge guard removed */',
    why: 'The once-per-edge promise is gone; the log floods for as long as a Core idles held.',
  },
  {
    id: 'xvi. an excluded device is never remembered (edge add removed)',
    file: HEAL,
    find: '    logged.add(m.sn);',
    to: '    /* MUTANT: edge add removed */',
    why: 'The guard never trips, so every tick logs the same exclusion again.',
  },
  {
    id: 'xvii. the exclusion edge never re-arms',
    file: HEAL,
    find: '  for (const sn of [...logged]) if (!current.has(sn)) logged.delete(sn);',
    to: '  /* MUTANT: edge never re-armed */',
    why: 'After the first night a device\'s later exclusions are never logged, so the absence of a line proves nothing.',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs);
// the verdict procedure per mutant (subset, then the full suite on a subset pass) is unchanged.
import { runMutantsParallel } from './lib/mutateParallel.mjs';
await runMutantsParallel({ name: 'mutate-heal-idle-quorum', mutants: MUTANTS, subset: SUBSET, root: REPO });
