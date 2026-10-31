#!/usr/bin/env node
/**
 * mutate-restart-leftovers.mjs — committed harness for v1.195.0, the restart and broadcast leftovers.
 *
 * (F3) A restart inside the held de-escalation of an audible level lost the all-clear: the hold
 * demoted the condition record to unheard, and the next boot joined the green in silence. The hold
 * of an audible level is now written with the record (conditionHeldFrom / conditionHeldAt), and a
 * green first tick within an hour of its start resumes it (restoredHeldDeescalation): the green is
 * held as a restart question on recoveryBaseline and announced as a recovery once it has stood its
 * dwell on a settled set (adopted silently when the question closes first). Mutants F-i..ix.
 * Review: a level made audible INSIDE its own hold (cleared while its announcement played, or its
 * retry played in the dwell) owes the all-clear too, and its heard flag goes to the hold, not the
 * record (noteHeldLevelAudible); the non-green first tick's resets and the resumed hold's silence
 * are pinned. Mutants F-x..xvi.
 *
 * (N8) Audibility per critical: a critical the words of the red would NAME that was never made
 * audible in the episode (audibleCritFps) is presented again when it returns inside the dwell, and
 * a same-level gap refusal of that return is re-presented. Mutants N-i..vi. Review: a heard
 * adoption (the red replay gate) counts only the critical it matched as named. Mutants N-vii..viii.
 *
 * (P6) A lower CONDITION deferral kept pending behind a higher retry (keptDeferral) is re-presented
 * once that retry is done — the slot free and nothing in the chain — after the same-level gap of
 * the last condition played (keptDeferralRepresent). Mutants P-i..v. Review: a condition retry a
 * dedicated alarm takes the slot from is kept the same way, and of two kept the more severe survives
 * (keepDeferral). Mutants P-vi..vii.
 *
 * (7D) The pool-unknown file believes an episode of up to 366 days (was 7), and a panel dark since
 * the restart is pending only until its carried reserve-blind alarm is raised (darkPanelBlindRaised;
 * the house panel has none while dark, so it stays pending). Mutants D-i..v. (v1.197.1: the pinned
 * house panel raises its alarm while dark and joins the set; D-iii re-pointed to a pin missing from
 * the account, which still has none — mutate-house-blind.mjs pins the rest.)
 *
 * (RO) A file found in a directory this process cannot write is not carried (poolUnknownDirWritable,
 * poolUnknownUntrusted), its panels stay pending, and its entries are never written back.
 * Mutants O-i..vi.
 *
 * Re-pointed elsewhere in this release: mutate-v1187-4.mjs H-i, H-ii, U-viii, C-ix, C-xvi, C-xx,
 * C-xxiii; mutate-v1187-3h.mjs B-i, B-ii; mutate-v1187-b.mjs xxiii, xxxv; mutate-multi-panel.mjs
 * r11; mutate-alert-monitor.mjs xxiii.
 *
 * Not mutated: the log texts; the 'broadcasts disabled' cancel of a kept deferral (its re-present
 * is refused by the same enable gate); recoveryBaseline ending with a recovery (as
 * continuationBaseline, whose ending mutate-v1187-3h.mjs pins); the write inside
 * noteHeldLevelAudible (a Music Assistant delivery writes the record at its end anyway; only a
 * cordless-only delivery relies on it); the same-level heard adoption's seed (reached only when the
 * red replay gate matches a critical joining a red committed after the boot).
 *
 *   MUTATE_CONCURRENCY=1 node scripts/mutate-restart-leftovers.mjs [--only <id prefix>]
 *
 * ★ Anchor-asserted (each anchor matches exactly once); every mutant must TYPECHECK (one that does
 *   not is reported INVALID and fails the run); each mutant names the test files that must kill it,
 *   and only those run for it; the unmutated tree must typecheck and pass them first.
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = resolve(REPO, 'server');
const BR = resolve(SERVER, 'src/broadcast.ts');
const SN = resolve(SERVER, 'src/snapshot.ts');
const AL = resolve(SERVER, 'src/alerts.ts');
const AM = resolve(SERVER, 'src/alertMonitor.ts');

const T_RESTART = 'test/restartRecoveryAllClear.test.ts';
const T_RETRY = 'test/conditionRetryNewestWins.test.ts';
const T_POOL = 'test/poolUnknownCarry.test.ts';
const T_HOUSE = 'test/houseReserveBlindDark.test.ts'; // v1.197.1

const MUTANTS = [
  /* ── F3: the all-clear a restart inside a held de-escalation owes ── */
  {
    id: 'F-i. ★★★ the record never names the hold',
    file: BR, tests: [T_RESTART],
    find: '          conditionHeldFrom: conditionHeldOwed?.from ?? null, conditionHeldAt: conditionHeldOwed?.atMs ?? null, // v1.195.0',
    to: '          conditionHeldFrom: null, conditionHeldAt: conditionHeldOwed?.atMs ?? null, /* MUTANT */',
    why: 'A restart inside the dwell of a heard red joins the green in silence: the cleared red stays the last words (F3).',
  },
  {
    id: 'F-ii. ★★★ a green first tick is joined whatever the record owes',
    file: BR, tests: [T_RESTART],
    find: "      if (level === 'green' && restoredOwed == null) {",
    to: "      if (level === 'green' && (restoredOwed == null || Date.now() > 0)) { /* MUTANT */",
    // (a runtime-true condition TS cannot narrow on: the resume branch below still typechecks)
    why: 'As F-i: the hold is never resumed (the green is routed as a boot level, and joined).',
  },
  {
    id: 'F-iii. ★★★ the recovery reads the continuation baseline (null for a demoted record)',
    file: BR, tests: [T_RESTART],
    find: "    const settledSinceMs = level === 'green' && recoveryBaseline != null ? alertSetSettledSince() : null;",
    to: "    const settledSinceMs = level === 'green' && continuationBaseline != null ? alertSetSettledSince() : null; /* MUTANT */",
    why: 'The resumed green is never a recovery: held to boot + 16 and adopted in silence on a settled set.',
  },
  {
    id: 'F-iv. ★★★ the continuation gate takes the resumed hold\'s level as heard',
    file: BR, tests: [T_RESTART],
    find: '  let continuationBaseline: ConditionLevel | null = bootBaselineLevel;',
    to: '  let continuationBaseline: ConditionLevel | null = bootBaselineLevel ?? restoredHeldDeescalation(persistedCondition, bootMs)?.from ?? null; /* MUTANT */',
    why: 'A warning standing below the cleared red is swallowed as a continuation of it — the demotion\'s whole point.',
  },
  {
    id: 'F-v. ★★ a hold of any age is resumed',
    file: BR, tests: [T_RESTART],
    find: '  if (bootMs - at > maxAgeMs) return null;',
    to: '  /* MUTANT */',
    why: 'A condition that cleared during a long outage gets an all-clear the documented rule withholds.',
  },
  {
    id: 'F-vi. ★★★ only a VERIFIED heard level owes its all-clear',
    file: BR, tests: [T_RESTART],
    find: '        const owed = conditionSpoken || committedAudible; // heard is audible',
    to: '        const owed = conditionSpoken; /* MUTANT */',
    why: 'A red heard as the tone alone (its spoken render failed) is cleared in silence after a restart.',
  },
  {
    id: 'F-vii. ★★ a resumed hold restarts its age at the boot',
    file: BR, tests: [T_RESTART],
    find: '        conditionHeldOwed = { ...restoredOwed };',
    to: '        conditionHeldOwed = { from: restoredOwed.from, atMs: Date.now() }; /* MUTANT */',
    why: 'Restarts less than an hour apart keep an owed all-clear for ever.',
  },
  {
    id: 'F-viii. ★★ a hold that ends with the level back keeps the owed record',
    file: BR, tests: [T_RESTART],
    find: '    const owedOnRecord = conditionHeldOwed != null;\n    conditionHeldOwed = null;',
    to: '    const owedOnRecord = conditionHeldOwed != null; /* MUTANT */',
    why: 'A red that flickered back and then cleared while the add-on was down gets an all-clear after the restart.',
  },
  {
    id: 'F-ix. ★★ a commit keeps the owed record',
    file: BR, tests: [T_RESTART],
    find: '    conditionHeldOwed = null; // v1.195.0 — written with the record below',
    to: '    /* MUTANT */',
    why: 'The all-clear said, the record still owes it: a restart within the hour says it again.',
  },
  {
    id: 'F-x. ★★★ a late delivery inside its own hold marks the RECORD heard (review)',
    file: BR, tests: [T_RESTART],
    find: "      if (kind === 'condition' && !deliveryUnverified && conditionLevel === level && !noteHeldLevelAudible(level, true)) conditionSpoken = true;",
    to: "      if (kind === 'condition' && !deliveryUnverified && conditionLevel === level) conditionSpoken = true; /* MUTANT */",
    why: 'A red that cleared while its announcement played re-promotes the record: a warning standing below it is swallowed as its continuation after a restart.',
  },
  {
    id: 'F-xi. ★★ audible inside its own hold owes nothing (review)',
    file: BR, tests: [T_RESTART],
    find: '    if (episode === conditionEpisode && level === prevLevel) noteHeldLevelAudible(level, false);',
    to: '    /* MUTANT */',
    why: 'A red heard as the tone alone after it had cleared gets no all-clear after a restart inside its dwell.',
  },
  {
    id: 'F-xii. ★★ the hold does not take the heard flag (review)',
    file: BR, tests: [T_RESTART],
    find: '    if (heard) h.heard = true;',
    to: '    /* MUTANT */',
    why: 'A red heard late that flickers back loses its heard flag: the next restart has no baseline for it.',
  },
  {
    id: 'F-xiii. ★★ a non-green first tick keeps the resumed recovery baseline (review)',
    file: BR, tests: [T_RESTART],
    find: '        conditionHeldOwed = null;\n        recoveryBaseline = bootBaselineLevel;',
    to: '        conditionHeldOwed = null; /* MUTANT */',
    why: 'A warning standing at the boot clears on an unsettled set: its all-clear is held as a recovery from the old red, and adopted silently.',
  },
  {
    id: 'F-xiv. ★★ a non-green first tick keeps the owed hold on record (review)',
    file: BR, tests: [T_RESTART],
    find: '        conditionHeldOwed = null;\n        recoveryBaseline = bootBaselineLevel;',
    to: '        recoveryBaseline = bootBaselineLevel; /* MUTANT */',
    why: 'The status and the record name a hold that no longer stands; a second restart before the warning commits resumes it.',
  },
  {
    id: 'F-xv. ★★ the resumed hold counts its level as audible (review)',
    file: BR, tests: [T_RESTART],
    find: '        prevLevel = restoredOwed.from;\n        prevCrit = 0;',
    to: '        prevLevel = restoredOwed.from;\n        prevCrit = 0; committedAudible = true; /* MUTANT */',
    why: 'A warning re-committed under the resumed hold that never reached the speakers is absorbed as a flicker when it returns.',
  },
  {
    id: 'F-xvi. ★★ a hold that ends without restoring the heard flag leaves the owed record on disk (review)',
    file: BR, tests: [T_RESTART],
    find: '    } else if (owedOnRecord) {\n      persistStatus();\n    }',
    to: '    } /* MUTANT */',
    why: 'A tone-only red that flickered back, then cleared while the add-on was down, gets an all-clear after the restart.',
  },

  /* ── N8: audibility per critical ── */
  {
    id: 'N-i. ★★★ an audible red names nothing',
    file: BR, tests: [T_RETRY],
    find: "    if (episode === conditionEpisode && level === 'red' && prevLevel === 'red' && named != null) audibleCritFps.add(named);",
    to: '    /* MUTANT */',
    why: 'Every flicker of a heard critical is announced again: the dwell absorbs nothing at red.',
  },
  {
    id: 'N-ii. ★★★ a return reads the episode\'s audibility only (N8)',
    file: BR, tests: [T_RETRY],
    find: '    const unheardReturn = deescalationHold != null && level === deescalationHold.from && !newCrit && (!committedAudible || unheardNamed);',
    to: '    const unheardReturn = deescalationHold != null && level === deescalationHold.from && !newCrit && !committedAudible; /* MUTANT */',
    why: 'A critical that took a heard one\'s place, never delivered, is absorbed when it returns — never named.',
  },
  {
    id: 'N-iii. ★★ what was named audible outlives its red episode',
    file: BR, tests: [T_RETRY],
    find: "      audibleCritFps = new Set(heard && l === 'red' && heardNamed != null ? [heardNamed] : []);",
    to: '      /* MUTANT */',
    why: 'A critical heard in an earlier red is absorbed in a later one where it was never delivered.',
  },
  {
    id: 'N-iv. ★★ any counted critical not named makes a return news',
    file: BR, tests: [T_RETRY],
    find: "    const unheardNamed = level === 'red' && voicedFingerprint != null && !audibleCritFps.has(voicedFingerprint);",
    to: "    const unheardNamed = level === 'red' && criticalFingerprints.some((f) => !audibleCritFps.has(f)); /* MUTANT */",
    why: 'Two criticals returning together, the words naming the heard one, sound again on every flicker.',
  },
  {
    id: 'N-v. ★★ a heard adoption (the red replay gate) names nothing',
    file: BR, tests: [T_RETRY],
    find: "      audibleCritFps = new Set(heard && l === 'red' && heardNamed != null ? [heardNamed] : []);",
    to: '      audibleCritFps = new Set(); /* MUTANT */',
    why: 'A standing critical adopted at a restart as already announced sounds again on its first flicker.',
  },
  {
    id: 'N-vi. ★★ a refused return of an unnamed critical is not re-presented',
    file: BR, tests: [T_RETRY],
    find: "    const fresh = level === 'red' ? criticalFingerprints.filter((f) => !prevCritFps.has(f) || (f === voicedFingerprint && !audibleCritFps.has(f)))",
    to: "    const fresh = level === 'red' ? criticalFingerprints.filter((f) => !prevCritFps.has(f)) /* MUTANT */",
    why: 'The return the same-level gap refuses is never said: the critical stays unnamed.',
  },
  {
    id: 'N-vii. ★★ a heard adoption counts every critical beside the named one (review)',
    file: BR, tests: [T_RETRY],
    find: "      audibleCritFps = new Set(heard && l === 'red' && heardNamed != null ? [heardNamed] : []);",
    to: "      audibleCritFps = new Set(heard && l === 'red' ? ids.crit : []); /* MUTANT */",
    why: 'A critical counted beside the one announced before the restart, never named, returns alone and is absorbed as a flicker.',
  },
  {
    id: 'N-viii. ★★ the red replay gate\'s adoption names nothing (review)',
    file: BR, tests: [T_RETRY],
    find: '      adoptLevel(level, crit, ids, true, voicedFingerprint); // v1.186.0',
    to: '      adoptLevel(level, crit, ids, true); /* MUTANT */ // v1.186.0',
    why: 'As N-v at the call: the critical announced before the restart sounds again on its first flicker.',
  },

  /* ── P6: a condition deferral kept behind a higher retry ── */
  {
    id: 'P-i. ★★★ a kept condition deferral is forgotten (P6)',
    file: BR, tests: [T_RETRY],
    find: '      const kept = kind === \'condition\' && keepDeferral({ level, episode, named });',
    to: '      const kept = false; /* MUTANT */',
    why: 'A warning under a held critical, or behind a battery alarm\'s retry, is never spoken while it stands.',
  },
  {
    id: 'P-ii. ★★ a kept deferral of an earlier episode is re-presented',
    file: BR, tests: [T_RETRY],
    find: "  if (kept.episode !== currentEpisode) return { drop: 'the condition has been committed at another level since' };",
    to: '  /* MUTANT */',
    why: 'A warning that cleared (its green committed since) is offered again under the next condition.',
  },
  {
    id: 'P-iii. ★★★ the re-present is due at once, inside the gap',
    file: BR, tests: [T_RETRY],
    find: '  const dueAtMs = gated ? Math.max(nowMs, lastPlayed.atMs + gapMs) : nowMs;',
    to: '  const dueAtMs = nowMs; /* MUTANT */',
    why: 'The warning is refused by the gap the red retry\'s delivery armed, and a re-present is never re-armed: lost.',
  },
  {
    id: 'P-iv. ★★ the re-present is armed while a fired retry is still in the chain',
    file: BR, tests: [T_RETRY],
    find: '    if (keptDeferral != null && retryTimer == null && retryLevel == null && realAudibleInFlight === 0 && deferredCondition == null) {',
    to: '    if (keptDeferral != null && retryTimer == null && retryLevel == null && deferredCondition == null) { /* MUTANT */',
    why: 'Queued behind the red retry it was waiting for, the warning is refused by that retry\'s gap: lost.',
  },
  {
    id: 'P-v. ★ a dedicated announcement is kept as a condition',
    file: BR, tests: [T_RETRY],
    find: '      const kept = kind === \'condition\' && keepDeferral({ level, episode, named });',
    to: '      const kept = keepDeferral({ level, episode, named }); /* MUTANT */',
    why: 'A battery notice kept behind a red retry is re-presented as whatever the condition says then.',
  },
  {
    id: 'P-vi. ★★★ a condition retry a dedicated alarm takes the slot from is forgotten (review)',
    file: BR, tests: [T_RETRY],
    find: "      const kept = retryKind === 'condition' && retryLevel != null && !stalePending && !outranked\n        && keepDeferral({ level: retryLevel, episode: retryEpisode, named: retryNamed });",
    to: '      const kept = false; /* MUTANT */',
    why: 'A warning or an all-clear whose retry a battery or runway alarm superseded is never spoken while it stands.',
  },
  {
    id: 'P-vii. ★★ a newer, milder deferral displaces the more severe one kept (review)',
    file: BR, tests: [T_RETRY],
    find: '    if (keptDeferral != null && keptDeferral.episode === conditionEpisode && RETRY_LEVEL_RANK[keptDeferral.level] > RETRY_LEVEL_RANK[k.level]) return false;',
    to: '    /* MUTANT */',
    why: 'A critical whose condition retry a dedicated alarm superseded is dropped for a warning behind that alarm, and never named.',
  },

  /* ── 7D: a panel dark for more than a week ── */
  {
    id: 'D-i. ★★★ the file believes 7 days at most (7D)',
    file: SN, tests: [T_POOL],
    find: 'export const POOL_UNKNOWN_MAX_EPISODE_MS = 366 * 24 * 60 * 60_000;',
    to: 'export const POOL_UNKNOWN_MAX_EPISODE_MS = 7 * 24 * 60 * 60_000; /* MUTANT */',
    why: 'A panel dark for more than a week loses its onset at every restart: absent 15 min, then a warning until boot + 60.',
  },
  {
    id: 'D-ii. ★★ a dark panel whose carried alarm is raised stays pending',
    file: AL, tests: [T_POOL],
    find: '  const raised = devices != null ? darkPanelBlindRaised(devices, connectivity, nowMs) : new Set<string>();',
    to: '  const raised = new Set<string>(); /* MUTANT */',
    why: 'A panel dark for weeks keeps the alert set unsettled for as long as it is dark.',
  },
  {
    id: 'D-iii. ★★★ every dark panel counts as raised, a pinned house panel MISSING from the account too',
    file: AL, tests: [T_POOL, T_HOUSE],
    // v1.197.1 — re-pointed: the pinned house panel with no projection now raises its own alarm and
    // is in the set (pinnedDarkHousePanel); what remains outside it is a pin missing from the
    // account, which has no reserve-blind alarm (the shp2-multi-panel critical stands).
    find: '  for (const panel of darkHouse ? [...secondaryPanels(devices), darkHouse] : secondaryPanels(devices)) {\n    if (panel.projection?.kind === \'shp2\') continue;\n    const since = darkPanelBlindSince(panel.sn, connectivity);',
    to: '  for (const panel of Object.values(devices).filter((d) => isShp2Product(d.productName))) { /* MUTANT */\n    if (panel.projection?.kind === \'shp2\') continue;\n    const since = darkPanelBlindSince(panel.sn, connectivity);',
    why: 'A missing house panel has no alarm while dark: a green read before it reports is taken as an all-clear.',
  },
  {
    id: 'D-iv. ★ raised one reading late',
    file: AL, tests: [T_POOL],
    find: '    if (since != null && Number.isFinite(since) && nowMs - since >= RESERVE_BLIND_AFTER_MS) out.add(panel.sn);',
    to: '    if (since != null && Number.isFinite(since) && nowMs - since > RESERVE_BLIND_AFTER_MS) out.add(panel.sn); /* MUTANT */',
    why: 'The pending rule and the alert disagree at the 15-minute mark.',
  },
  {
    id: 'D-v. ★★ the monitor withholds the device map',
    file: AM, tests: [T_POOL],
    find: '    const pendingOnsets = debouncedOnsetsPending(connectivity, liveAtMs, snap.devices);',
    to: '    const pendingOnsets = debouncedOnsetsPending(connectivity, liveAtMs); /* MUTANT */',
    why: 'As D-ii in production.',
  },

  /* ── RO: a file this process cannot keep current ── */
  {
    id: 'O-i. ★★★ every directory reads as writable (RO)',
    file: SN, tests: [T_POOL],
    find: '    access(dirname(path), fsConstants.W_OK);\n    return true;',
    to: '    return true; /* MUTANT */',
    why: 'On a read-only /data a retired onset is carried: a false off-grid critical "unreadable for 2 h".',
  },
  {
    id: 'O-ii. ★★★ the first projection carries an untrusted onset',
    file: SN, tests: [T_POOL],
    find: '        const carried = this.poolUnknownUntrusted ? null : carriedPoolUnknownSince(onDisk, nowMs);',
    to: '        const carried = carriedPoolUnknownSince(onDisk, nowMs); /* MUTANT */',
    why: 'As O-i at the panel\'s first projection.',
  },
  {
    id: 'O-iii. ★★ an untrusted panel is not pending',
    file: SN, tests: [T_POOL],
    find: '    return [...this.pendingPoolUnknown().keys()].sort();',
    to: '    return [...this.poolUnknownCarried().keys()].sort(); /* MUTANT */',
    why: 'A green read before the panel reports is taken as an all-clear.',
  },
  {
    id: 'O-iv. ★★ untrusted entries are written back',
    file: SN, tests: [T_POOL],
    find: '        if (!this.poolUnknownUntrusted) out[sn] = held;',
    to: '        out[sn] = held; /* MUTANT */',
    why: 'Once the directory can be written again, the stale onset is laundered into a fresh-looking entry.',
  },
  {
    id: 'O-v. ★★ a dark panel is blind since the untrusted onset',
    file: SN, tests: [T_POOL],
    find: '    return this.poolUnknownUntrusted ? new Map() : this.pendingPoolUnknown();',
    to: '    return this.pendingPoolUnknown(); /* MUTANT */',
    why: 'As O-i for a panel still dark after the restart.',
  },
  {
    id: 'O-vi. ★ the untrusted file is set aside in silence',
    file: SN, tests: [T_POOL],
    find: '      log(this.poolUnknownLoadNote);',
    to: '      /* MUTANT */',
    why: 'A reserve-blind clock restarted after a restart has no line saying why.',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs);
// MUTATE_CONCURRENCY=1 keeps the timing-sensitive broadcast rigs off a loaded machine.
import { runMutantsParallel } from './lib/mutateParallel.mjs';
await runMutantsParallel({ name: 'mutate-restart-leftovers', mutants: MUTANTS, subset: [], root: REPO, perMutantTests: true, typecheck: true, fullSuite: false });
