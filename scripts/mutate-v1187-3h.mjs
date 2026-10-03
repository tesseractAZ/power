#!/usr/bin/env node
/**
 * mutate-v1187-3h.mjs — committed harness for v1.187.3 group H: alerts and announcements.
 *
 * (1) ems-window-1: the EMS parallel band is relative (it follows the Core's own voltage), so
 * `ems-volt-<sn>` is an info / Low notice, audible:false, with an honest title and detail (EN, ES):
 * it never pushes, never raises or voices the condition; cell-ovp-* still pages. Its cleared rows
 * keep the warning eviction tier (CLEARED_INFO_KEPT_AS_WARNING_PREFIXES). Mutants E-i..E-ix.
 *
 * (2) ems-window-2: the recorder stores ems_para_vol_min_mv / ems_para_vol_max_mv beside bat_vol.
 * Mutants R-i..R-iii.
 *
 * (3) general-2: peer-voldiff is in TELEMETRY_FAMILY_BASIS, so pre-v1.187.3 lines (which counted
 * the low side v1.187.1 muted) are not replayed; the boot line names each basis's reason.
 * Mutants T-i..T-iii.
 *
 * (4) general-3: a push auto-tuned to [Low] still owes its "Resolved:" (the card dismissal); an
 * ISA priority turned off since the push still suppresses it. Mutants S-i..S-iii.
 *
 * (5) restart-continuation-allclear: a green that has stood its dwell on a settled alert set after
 * a restart is a recovery, announced once (isRestartRecovery); yellow continuation and the silent
 * boot green are unchanged. Mutants B-i..B-xix. (review) The dwell is measured ON the settled set,
 * from the alert monitor's stamp (alertSetTrusted: hydrated, every feed's delivery in the set, the
 * boot onset debounces run, no onset clock withholding a fault — alerts.debouncedOnsetsPending);
 * the green is held until then, and adopted silently if the warm-up ends first. Mutants A-i..A-xv.
 * Not mutated: the stamp reading each feed's warmth from its read (AlertFeedRead.warm) rather than
 * from warm() after Promise.all — the two differ only for a fetch landing in the milliseconds
 * between two equal budget timers; A-ix pins the read field itself.
 *
 * (6) log review 10-01 (MEDIUM): the sounded-critical record (soundedCriticalHeld) survives a
 * restart — written to the broadcast status file when its set changes and at most every minute
 * while it holds anything, restored before the first tick whatever the condition record says
 * (entries at most SOUNDED_CRIT_RESTORE_MAX_AGE_MS old, stamped at the boot); a status file written
 * before v1.187.3 seeds the red announcement's criticals under a heard red. Mutants P-i..P-xiv.
 * Not mutated: the restore running before the first tick (it runs in the monitor's constructor,
 * the tick on a later timer; no single-line edit moves it).
 *
 * (7) log review 10-01 (LOW): stormPrepAlerts throws, uncached, when NWS is enabled and the fetch
 * failed with nothing cached, so the storm-prep feed stays cold and the set is not settled; a
 * successful empty fetch is still []. Mutants N-i..N-iii.
 *
 * (8) seam fixes (five LOW findings on (6) and (7)):
 *   - a green held inside the warm-up by a sounded critical has its recovery decided even when its
 *     dwell ends past the warm-up (deescalationHold.soundedHeldInWarmup). Mutants Q-i..Q-v.
 *     (seam review, MEDIUM) Only a critical restored or seeded at the boot, and not released since,
 *     marks the hold (bootSoundedFps): a red heard after the restart gets its all-clear. Mutants
 *     Q-vi..Q-ix. The decision past the warm-up waits up to one more dwell for a settled set, the
 *     patience the warm-up gives. Mutants Q-x, Q-xi.
 *   - (seam review, LOW) a green still held for its recovery when the warm-up ends is spoken, not
 *     adopted silently, when a condition above green has been spoken since the boot
 *     (lastConditionPlayedLevel). Mutants L-i, L-ii.
 *   - the pre-v1.187.3 fallback seed keys on the COMMITTED red on record, not a heard one. Mutants
 *     P-viii, P-ix (re-pointed), P-xv.
 *   - the disk keeps a restored entry's own last-present time until it is present again
 *     (soundedCritRestoredAt), never later than the boot. Mutants D-i..D-iv.
 *   - only cell-spread criticals are written, drive a write, refresh, restore or seed
 *     (soundedCritPersists). Mutants K-i..K-vi. K-vi (the seed's filter) is observable only in the
 *     boot line: a seeded critical of another family holds nothing (pinned by K-i's tests).
 *   - getNwsAlerts backs off a failed fetch (NWS_ALERTS_FAILURE_BACKOFF_MS), answering inside it as
 *     the failure did (the feed stays cold), and concurrent callers share one request. Mutants
 *     N-iv..N-ix.
 *
 *   node scripts/mutate-v1187-3h.mjs
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
const AL = resolve(SERVER, 'src/alerts.ts');
const AM = resolve(SERVER, 'src/alertMonitor.ts');
const AT = resolve(SERVER, 'src/alertTelemetry.ts');
const AN = resolve(SERVER, 'src/analytics.ts');
const BR = resolve(SERVER, 'src/broadcast.ts');
const IX = resolve(SERVER, 'src/index.ts');
const NW = resolve(SERVER, 'src/nws.ts');
const RC = resolve(SERVER, 'src/recorder.ts');
const TT = resolve(SERVER, 'src/ttsService.ts');

const SUBSET = [
  'test/restartRecoveryAllClear.test.ts',
  'test/restartRecoverySettledSet.test.ts',
  'test/emsBandNotice.test.ts',
  'test/clearedLedgerRetention.test.ts',
  'test/recorderEmsBand.test.ts',
  'test/peerVoldiffTelemetryRebase.test.ts',
  'test/mpptFamilyTelemetryRebase.test.ts',
  'test/autoTuneOwedResolve.test.ts',
  'test/demotedPushResolve.test.ts',
  'test/alertResolveEvidence.test.ts',
  'test/owedResolveAfterMute.test.ts',
  'test/peerSpreadTopOfChargeAudible.test.ts',
  'test/stormPrepUnknownFeed.test.ts',
];

const MUTANTS = [
  /* ── (1) the EMS band notice ─────────────────────────────────────────── */
  {
    id: 'E-i. ★★★ the notice is a warning again',
    file: AL,
    find: "          id: `ems-volt-${d.sn}`, severity: 'info', priority: 'low', audible: false, category: 'Battery', device: d.deviceName,",
    to: "          id: `ems-volt-${d.sn}`, severity: 'warning', priority: 'low', audible: false, category: 'Battery', device: d.deviceName, /* MUTANT */",
    why: 'A relative band at the top of charge pushes and counts toward the condition again.',
  },
  {
    id: 'E-ii. ★★★ a warning with no explicit priority (ISA High, the pre-v1.187.3 rule)',
    file: AL,
    find: "          id: `ems-volt-${d.sn}`, severity: 'info', priority: 'low', audible: false, category: 'Battery', device: d.deviceName,",
    to: "          id: `ems-volt-${d.sn}`, severity: 'warning', category: 'Battery', device: d.deviceName, /* MUTANT */",
    why: 'The 10-01 13:25 [High] push, yellow and spoken alarm return.',
  },
  {
    id: 'E-iii. ★★ the audible gate is dropped',
    file: AL,
    find: "          id: `ems-volt-${d.sn}`, severity: 'info', priority: 'low', audible: false, category: 'Battery', device: d.deviceName,",
    to: "          id: `ems-volt-${d.sn}`, severity: 'info', priority: 'low', category: 'Battery', device: d.deviceName, /* MUTANT */",
    why: 'The belt-and-braces audible:false is not pinned.',
  },
  {
    id: 'E-iv. ★★★ the notice is never raised (the card is lost)',
    file: AL,
    find: '      if (batMv < p.emsParaVolMinMv || batMv > p.emsParaVolMaxMv) {',
    to: '      if (false) { /* MUTANT */',
    why: 'The band episode is no longer shown at all.',
  },
  {
    id: 'E-v. ★★ the detail always says "below"',
    file: AL,
    find: "${batMv < p.emsParaVolMinMv ? 'below' : 'above'}",
    to: "${'below' /* MUTANT */}",
    why: 'A grid-charge onset above the band reads as below it.',
  },
  {
    id: 'E-vi. ★★ the old title (a "window", read as a limit)',
    file: AL,
    find: "          title: 'Pack voltage swing outside EMS band',",
    to: "          title: 'Pack voltage outside EMS window', /* MUTANT */",
    why: 'The card claims a limit that does not exist.',
  },
  {
    id: 'E-vii. ★ the old Spanish title ("outside the permitted range")',
    file: TT,
    find: "  ['ems-volt', 'Oscilación de voltaje fuera de la banda del EMS'],",
    to: "  ['ems-volt', 'Voltaje de batería fuera del rango permitido'], /* MUTANT */",
    why: 'The Spanish title still claims a limit.',
  },
  {
    id: 'E-viii. ★★★ an ems-volt row is evicted as info (first out of a full ledger)',
    file: AM,
    find: "    return s === 'info' && typeof id === 'string' && CLEARED_INFO_KEPT_AS_WARNING_PREFIXES.some((p) => id.startsWith(p)) ? 'warning' : s;",
    to: '    return s; /* MUTANT */',
    why: 'Each band episode (and warranty evidence) leaves the ledger on the next clear.',
  },
  {
    id: 'E-ix. ★★ the kept-as-warning list is empty',
    file: AM,
    find: "export const CLEARED_INFO_KEPT_AS_WARNING_PREFIXES: readonly string[] = ['ems-volt-'];",
    to: 'export const CLEARED_INFO_KEPT_AS_WARNING_PREFIXES: readonly string[] = []; /* MUTANT */',
    why: 'As E-viii.',
  },
  /* ── (2) the recorder ────────────────────────────────────────────────── */
  {
    id: 'R-i. ★★★ the band floor is not recorded',
    file: RC,
    find: "        push('ems_para_vol_min_mv', dpu.emsParaVolMinMv);",
    to: '        /* MUTANT */',
    why: 'An episode cannot be checked against batVol afterwards.',
  },
  {
    id: 'R-ii. ★★★ the band ceiling is not recorded',
    file: RC,
    find: "        push('ems_para_vol_max_mv', dpu.emsParaVolMaxMv);",
    to: '        /* MUTANT */',
    why: 'As R-i, for the upper edge.',
  },
  {
    id: 'R-iii. ★★ a missing band is recorded as 0',
    file: RC,
    find: "        push('ems_para_vol_min_mv', dpu.emsParaVolMinMv);",
    to: "        push('ems_para_vol_min_mv', dpu.emsParaVolMinMv ?? 0); /* MUTANT */",
    why: 'A fabricated 0 V floor reads as a measurement.',
  },
  /* ── (3) the peer-voldiff telemetry basis ────────────────────────────── */
  {
    id: 'T-i. ★★★ peer-voldiff is not rebased',
    file: AT,
    find: "  'peer-voldiff': 'peer-voldiff-high-side',",
    to: '  /* MUTANT */',
    why: 'The low-side pairs v1.187.1 muted keep the family at the Rule 2 cutoff until they age out.',
  },
  {
    id: 'T-ii. ★★ the boot line gives the MPPT reason for every family',
    file: AM,
    find: "  const dropped = [...new Set(families.map((f) => TELEMETRY_BASIS_DROPPED[telemetryBasisFor(f) ?? ''] ?? 'episodes an earlier rule counted'))];",
    to: "  const dropped = ['cooler-than-typical and load-explained MPPT episodes']; /* MUTANT */",
    why: 'The log says MPPT episodes were set aside when it was the peer cell spread.',
  },
  {
    id: 'T-iii. ★★ the boot line drops the lifted verdicts',
    file: AM,
    find: '      log(rebasedReplayLine(r, liftedIn(r.rebasedFamilies)));',
    to: '      log(rebasedReplayLine(r, [])); /* MUTANT */',
    why: 'Which demotion or silence the rebase lifted is no longer said.',
  },
  /* ── (4) the resolve of a demoted push ───────────────────────────────── */
  {
    id: 'S-i. ★★★ the resolve qualifies the alert\'s last-tick severity, not the dispatched one',
    file: AM,
    find: '    qualifies(t.notifiedSeverity ?? t.alert.severity, minSeverity)',
    to: '    qualifies(t.alert.severity, minSeverity) /* MUTANT */',
    why: 'A peer outlier that reads info on its last tick strands the card its warning push opened.',
  },
  {
    id: 'S-ii. ★★★ a demoted family owes no resolve (the v1.88.0 exception, by the rollup)',
    file: AM,
    find: '      } else if (shouldSendResolve(t, cfg.notifyResolved, cfg.minSeverity)) {',
    to: '      } else if (shouldSendResolve(t, cfg.notifyResolved, cfg.minSeverity) && !telemetry.get(familyOf(id))?.warningDemotedToInfo) { /* MUTANT */',
    why: 'The 10-01 [Low] peer cell-spread card stands in the drawer after its condition cleared.',
  },
  {
    id: 'S-iii. ★★★ the priority-disabled exception is lost for resolves',
    file: AM,
    find: '    if (!isPriorityEnabled(priorityOf(alert))) {',
    to: "    if (kind === 'new' && !isPriorityEnabled(priorityOf(alert))) { /* MUTANT */",
    why: 'A priority the operator turned off still sends its resolve.',
  },
  /* ── (5) the restart recovery ────────────────────────────────────────── */
  {
    id: 'B-i. ★★★ the tick never takes a recovery',
    file: BR,
    find: '    const recovery = recoveryCandidate\n      && isRestartRecovery(continuationBaseline, level, greenSinceMs, Date.now(), settledSinceMs);',
    to: '    const recovery = false; /* MUTANT */',
    why: 'The 10-01 all-clear is held and then adopted in silence; the cleared warning stays the last words.',
  },
  {
    id: 'B-ii. ★★★ the tick reads the alert set as settled since forever',
    file: BR,
    // v1.187.4 — re-pointed: the stamp is read before recoveryCandidate (restartQuestionOpen needs it).
    find: "    const settledSinceMs = level === 'green' && continuationBaseline != null ? alertSetSettledSince() : null;",
    to: "    const settledSinceMs = level === 'green' && continuationBaseline != null ? 0 : null; /* MUTANT */",
    why: 'A green read before the set settled is spoken as an all-clear (the boot false-green).',
  },
  {
    id: 'B-iii. ★★★ the predicate ignores the settled stamp',
    file: BR,
    find: '  if (greenSinceMs == null || alertSetSettledSinceMs == null) return false;\n  return nowMs - Math.max(greenSinceMs, alertSetSettledSinceMs) >= dwellMs;',
    to: '  if (greenSinceMs == null) return false;\n  return nowMs - greenSinceMs >= dwellMs; /* MUTANT */',
    why: 'As B-ii.',
  },
  {
    id: 'B-iv. ★★★ (review) the dwell is measured from the green alone, not on the settled set',
    file: BR,
    find: '  return nowMs - Math.max(greenSinceMs, alertSetSettledSinceMs) >= dwellMs;',
    to: '  return nowMs - greenSinceMs >= dwellMs; /* MUTANT */',
    why: 'A green that began before the set settled is spoken the moment it settles, ahead of a critical still inside its restarted debounce.',
  },
  {
    id: 'B-v. ★★ the predicate does not require the dwell',
    file: BR,
    find: '  return nowMs - Math.max(greenSinceMs, alertSetSettledSinceMs) >= dwellMs;',
    to: '  return true; /* MUTANT */',
    why: 'A green on a set settled a moment ago is a recovery.',
  },
  {
    id: 'B-vi. ★★ the dwell bound is exclusive',
    file: BR,
    find: '  return nowMs - Math.max(greenSinceMs, alertSetSettledSinceMs) >= dwellMs;',
    to: '  return nowMs - Math.max(greenSinceMs, alertSetSettledSinceMs) > dwellMs; /* MUTANT */',
    why: 'Off by one against the de-escalation dwell it shares.',
  },
  {
    id: 'B-vii. ★★★ a yellow can be a recovery',
    file: BR,
    find: "  if (observed !== 'green') return false;\n  if (baseline == null) return false;",
    to: "  if (observed === 'red') return false; /* MUTANT */\n  if (baseline == null) return false;",
    why: 'The predicate calls a yellow under a heard red a recovery; yellow continuation is unchanged by design.',
  },
  {
    id: 'B-viii. ★★ no heard baseline is required',
    file: BR,
    find: '  if (baseline == null) return false;\n  if (greenSinceMs == null || alertSetSettledSinceMs == null) return false;',
    to: '  /* MUTANT */\n  if (greenSinceMs == null || alertSetSettledSinceMs == null) return false;',
    why: 'The predicate claims a recovery where nothing was heard before the restart.',
  },
  {
    id: 'B-ix. ★★★ the baseline does not end with the recovery',
    file: BR,
    find: '      continuationBaseline = null;',
    to: '      /* MUTANT */',
    why: 'A new warning after the spoken all-clear is filed as a continuation and never spoken.',
  },
  {
    id: 'B-x. ★★★ the continuation still reads the boot baseline',
    file: BR,
    find: '    if (transitioned && !higherAudible && isRestartContinuation(continuationBaseline, level, Date.now() - bootMs)) {', // v1.187.4 — re-pointed
    to: '    if (transitioned && !higherAudible && isRestartContinuation(bootBaselineLevel, level, Date.now() - bootMs)) { /* MUTANT */',
    why: 'A warning after the spoken all-clear is filed as a continuation of the boot baseline.',
  },
  {
    id: 'B-xi. ★★ the recovery is decided outside the warm-up',
    file: BR,
    // v1.187.4 — re-pointed: the window is restartQuestionOpen (the warm-up, then to boot + 16 min).
    find: '      && (questionOpen || (deescalationHold?.soundedHeldInWarmup === true\n        && (recoveryHoldSinceMs == null || Date.now() - recoveryHoldSinceMs < CONDITION_CLEAR_DWELL_MS)));',
    to: '      ; /* MUTANT */',
    why: 'A routine green long after boot is logged as a restart recovery, or held for one forever.',
  },
  {
    id: 'B-xii. ★★★ (review) the green is not held for its recovery: adopted at the plain dwell',
    file: BR,
    find: '    if (downward && !newWarn && (!lowerDue || (recoveryCandidate && !recovery))) {',
    to: '    if (downward && !newWarn && !lowerDue) { /* MUTANT */',
    why: 'A green that began before the set settled is adopted as a continuation at its plain dwell; the recovery is unreachable.',
  },
  {
    id: 'B-xiii. ★★★ (review) the warm-up ends and the held green is spoken on an unsettled set',
    file: BR,
    find: "    } else if (transitioned && level === 'green' && recoveryHoldSinceMs != null && !inWarmup) {",
    to: '    } else if (false) { /* MUTANT */',
    why: 'An all-clear read from a set that never settled is spoken when the warm-up ends.',
  },
  {
    id: 'B-xiv. ★★ the held-for-recovery mark is never set',
    file: BR,
    find: '        recoveryHoldSinceMs = Date.now();',
    to: '        /* MUTANT */',
    why: 'The held line repeats every tick, and the warm-up end speaks the unsettled green.',
  },
  {
    id: 'B-xv. ★★ the held-for-recovery mark outlives its green',
    file: BR,
    find: '    if (greenSinceMs == null) recoveryHoldSinceMs = null;',
    to: '    /* MUTANT */',
    why: 'A later green, begun after a flicker and stood past the warm-up, is adopted in silence instead of spoken.',
  },
  {
    id: 'B-xvi. ★★ an absent settled reader reads as settled',
    file: BR,
    find: '      const v = opts.alertSetSettledSince?.();',
    to: '      const v = opts.alertSetSettledSince?.() ?? 0; /* MUTANT */',
    why: 'A monitor not wired to the alert monitor speaks a green it cannot vouch for.',
  },
  {
    id: 'B-xvii. ★★ a throwing settled reader reads as settled',
    file: BR,
    find: "      return typeof v === 'number' && Number.isFinite(v) ? v : null;\n    } catch { return null; }",
    to: "      return typeof v === 'number' && Number.isFinite(v) ? v : null;\n    } catch { return 0; } /* MUTANT */",
    why: 'An unreadable stamp is taken as settled.',
  },
  {
    id: 'B-xviii. ★ a non-finite stamp is taken as a time',
    file: BR,
    find: "      return typeof v === 'number' && Number.isFinite(v) ? v : null;",
    to: "      return typeof v === 'number' ? v : null; /* MUTANT */",
    why: 'A -Infinity stamp reads as settled since forever.',
  },
  {
    id: 'B-xix. ★★★ production: the broadcast is not handed the alert monitor\'s stamp',
    file: IX,
    find: '  alertSetSettledSince: () => monitor.alertSetSettledSince(),',
    to: '  alertSetSettledSince: () => (store.firstPollSettledAt > 0 ? 0 : null), /* MUTANT */',
    why: 'The add-on speaks a green read from a hydrated store before the feeds and the boot debounces (the one-line wiring pin).',
  },
  /* ── (5) review: the alert monitor's settled stamp ───────────────────── */
  {
    id: 'A-i. ★★★ (review) the stamp reverts to the first cut: hydrated and feeds warm only',
    file: AM,
    find: '  if (p.liveAtMs - p.firstPollSettledAt < (p.bootDebounceMs ?? BOOT_RESET_ONSET_DEBOUNCE_MS)) return false;\n  return p.pendingOnsets.length === 0;',
    to: '  return true; /* MUTANT */',
    why: 'The review replay: "All clear", then the withheld dpu-err klaxon.',
  },
  {
    id: 'A-ii. ★★★ the boot debounce window is not waited out',
    file: AM,
    find: '  if (p.liveAtMs - p.firstPollSettledAt < (p.bootDebounceMs ?? BOOT_RESET_ONSET_DEBOUNCE_MS)) return false;',
    to: '  /* MUTANT */',
    why: 'A set read in the first 3 min after the first poll is trusted though a restarted onset clock may still be hiding a fault.',
  },
  {
    id: 'A-iii. ★★★ a pending onset clock does not unsettle the set',
    file: AM,
    find: '  return p.pendingOnsets.length === 0;',
    to: '  return true; /* MUTANT */',
    why: 'A fault the device reports now, withheld by its debounce (or a pool unknown under 15 min), reads as absent.',
  },
  {
    id: 'A-iv. ★★★ the feeds in the set are not consulted',
    file: AM,
    find: '  if (p.feedsInSet.length === 0 || !p.feedsInSet.every((w) => w === true)) return false;',
    to: '  if (p.feedsInSet.length === 0) return false; /* MUTANT */',
    why: 'A green read before a worker feed has delivered once is trusted.',
  },
  {
    id: 'A-v. ★★ no feeds at all settles',
    file: AM,
    find: '  if (p.feedsInSet.length === 0 || !p.feedsInSet.every((w) => w === true)) return false;',
    to: '  if (!p.feedsInSet.every((w) => w === true)) return false; /* MUTANT */',
    why: 'A wiring fault that drops every feed is read as a settled set.',
  },
  {
    id: 'A-vi. ★★ an unhydrated store settles',
    file: AM,
    find: '  if (!(p.firstPollSettledAt > 0)) return false;',
    to: '  /* MUTANT */',
    why: 'An empty device map (reads green) is trusted.',
  },
  {
    id: 'A-vii. ★★★ a pass whose first publish is not trusted does not clear the stamp',
    file: AM,
    find: '      alertSetSettledSinceMs = null;',
    to: '      /* MUTANT */',
    why: 'A fault that starts while the green stands on a settled set does not unsettle it: the green is spoken while the fault stands its debounce.',
  },
  {
    id: 'A-viii. ★★ the stamp moves on every settled pass',
    file: AM,
    find: '      if (alertSetSettledSinceMs == null) alertSetSettledSinceMs = Date.now();',
    to: '      alertSetSettledSinceMs = Date.now(); /* MUTANT */',
    why: 'The green can never stand its dwell on the set: no recovery is ever spoken.',
  },
  {
    id: 'A-ix. ★★★ a feed read reports warm though its value is not a delivery',
    file: AM,
    find: '      return { value: last != null ? clone(last.value) : null, fresh, firstDelivery, ageMs, error, warm: hydratedLanded };',
    to: '      return { value: last != null ? clone(last.value) : null, fresh, firstDelivery, ageMs, error, warm: true }; /* MUTANT */',
    why: 'A cold feed\'s empty read counts as its alerts being in the set.',
  },
  {
    id: 'A-x. ★★★ a pending inverter error is not listed',
    file: AL,
    find: "  for (const [sn, o] of connectivity.dpuErrOnsetBySn ?? []) if (within(o.sinceMs, DPU_ERR_DEBOUNCE_MS)) out.push(`dpu-err ${sn}`);",
    to: '  /* MUTANT */',
    why: 'A critical inverter error inside its debounce does not unsettle the set.',
  },
  {
    id: 'A-xi. ★★★ a pending SHP2 source error is not listed',
    file: AL,
    find: "  for (const [key, o] of connectivity.shp2SrcErrOnsetBySlot ?? []) if (within(o.sinceMs, DPU_ERR_DEBOUNCE_MS)) out.push(`shp2-src-err ${key}`);",
    to: '  /* MUTANT */',
    why: 'As A-x, for the critical shp2-src-err.',
  },
  {
    id: 'A-xii. ★★ a pending MPPT error is not listed',
    file: AL,
    find: "  for (const [key, o] of connectivity.mpptErrOnsetByKey ?? []) if (within(o.sinceMs, MPPT_ERR_DEBOUNCE_MS)) out.push(`mppt-err ${key}`);",
    to: '  /* MUTANT */',
    why: 'As A-x, for the MPPT string warning.',
  },
  {
    id: 'A-xiii. ★★★ an unknown pool is not listed',
    file: AL,
    find: '  for (const [sn, since] of pools) if (within(since, RESERVE_BLIND_AFTER_MS)) out.push(`reserve-alarm-blind ${sn}`);',
    to: '  /* MUTANT */',
    why: 'A reserve-alarm-blind warning withheld for 15 min after the boot reads as absent: "All clear", then the warning.',
  },
  {
    id: 'A-xiv. ★★ the debounce comparison is inclusive',
    file: AL,
    find: '    sinceMs != null && Number.isFinite(sinceMs) && nowMs - sinceMs < windowMs;',
    to: '    sinceMs != null && Number.isFinite(sinceMs) && nowMs - sinceMs <= windowMs; /* MUTANT */',
    why: 'Off by one against the rules, which publish at exactly the window.',
  },
  {
    id: 'A-xv. ★★ the boot debounce window is zero',
    file: AL,
    find: 'export const BOOT_RESET_ONSET_DEBOUNCE_MS = Math.max(DPU_ERR_DEBOUNCE_MS, MPPT_ERR_DEBOUNCE_MS);',
    to: 'export const BOOT_RESET_ONSET_DEBOUNCE_MS = 0; /* MUTANT */',
    why: 'As A-ii.',
  },

  /* ── (6) log review 10-01: the sounded record survives a restart ──────── */
  {
    id: 'P-i. ★★★ nothing is restored at boot',
    file: BR,
    find: '    const restored = restoreSoundedCriticals(persistedSoundedCrit, bootMs);',
    to: '    const restored = new Map<string, number>(); /* MUTANT */',
    why: 'A vdiff-crit that sounded before the restart and is knee-muted after it reads as never sounded: "All clear" with its card open.',
  },
  {
    id: 'P-ii. ★★★ the record is not written to the status file',
    file: BR,
    find: '          soundedCrit: Object.fromEntries(soundedCritKept().map(([f, at]) => [f, soundedCritRestoredAt.get(f) ?? at])), // v1.187.3 (restoreSoundedCriticals)',
    to: '          /* MUTANT */',
    why: 'Only the red-replay fallback is left, and it is empty once a green was observed under the hold.',
  },
  {
    id: 'P-iii. ★★★ restored only under a heard red',
    file: BR,
    find: '    const restored = restoreSoundedCriticals(persistedSoundedCrit, bootMs);',
    to: "    const restored = bootBaselineLevel === 'red' ? restoreSoundedCriticals(persistedSoundedCrit, bootMs) : new Map<string, number>(); /* MUTANT */",
    why: 'The hold demotes the heard flag exactly while a sounded critical is muted: a restart then loses it.',
  },
  {
    id: 'P-iv. ★★ the record on disk is not refreshed while the critical stands',
    file: BR,
    find: '      || (soundedCritKept().length > 0 && tickNow - soundedCritWritten.atMs >= SOUNDED_CRIT_PERSIST_EVERY_MS)) persistStatus();',
    to: '      ) persistStatus(); /* MUTANT */',
    why: 'A critical loud for more than an hour carries its commit time on disk: too old to restore.',
  },
  {
    id: 'P-v. ★★ a change of the set is not written',
    file: BR,
    find: '    if (soundedCritKeys() !== soundedCritWritten.keys',
    to: '    if (false /* MUTANT */',
    why: 'A critical released before the restart is restored after it, and its muted return holds the all-clear.',
  },
  {
    id: 'P-vi. ★★ no age bound on the restore',
    file: BR,
    find: '    if (bootMs - at > maxAgeMs) continue;',
    to: '    /* MUTANT */',
    why: 'A record from before a long outage holds a critical whose knee session started afresh.',
  },
  {
    id: 'P-vii. ★★ restored at its own last-present time: the outage counts as absence',
    file: BR,
    find: '    out.set(f, bootMs);',
    to: '    out.set(f, at); /* MUTANT */',
    why: 'A vdiff-crit between readings is released minutes early after a deploy.',
  },
  {
    id: 'P-viii. ★★ no seed from the red announcement for a status file written before v1.187.3',
    file: BR,
    find: "      persistedCondition?.conditionLevel === 'red'",
    to: '      false /* MUTANT */',
    why: 'The upgrade restart itself re-opens the defect.',
  },
  {
    id: 'P-ix. ★★ the seed without a committed red',
    file: BR,
    find: "      persistedCondition?.conditionLevel === 'red'",
    to: '      true /* MUTANT */',
    why: 'A critical released before a yellow was committed is held again after the restart.',
  },
  {
    id: 'P-x. ★ a malformed fingerprint is restored',
    file: BR,
    find: "    if (!isFingerprint(f) || typeof at !== 'number' || !Number.isFinite(at)) continue;",
    to: "    if (typeof at !== 'number' || !Number.isFinite(at)) continue; /* MUTANT */",
    why: 'A bare id never matches a fingerprint; it is junk in the record.',
  },
  {
    id: 'P-xi. ★ a non-finite last-present time is restored',
    file: BR,
    find: "    if (!isFingerprint(f) || typeof at !== 'number' || !Number.isFinite(at)) continue;",
    to: "    if (!isFingerprint(f) || typeof at !== 'number') continue; /* MUTANT */",
    why: '-Infinity passes the age bound.',
  },
  {
    id: 'P-xii. ★ an array is read as the record',
    file: BR,
    find: "  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return null;",
    to: "  if (raw == null || typeof raw !== 'object') return null; /* MUTANT */",
    why: 'A malformed field reads as a v1.187.3 record with nothing sounded, so the fallback is skipped.',
  },
  {
    id: 'P-xiii. ★ the restore bound is the absent hold',
    file: BR,
    find: 'export const SOUNDED_CRIT_RESTORE_MAX_AGE_MS = VDIFF_KNEE_GAP_CARRY_MS;',
    to: 'export const SOUNDED_CRIT_RESTORE_MAX_AGE_MS = SOUNDED_VDIFF_ABSENT_HOLD_MS; /* MUTANT */',
    why: 'An outage longer than 7 minutes (a host reboot) loses the record while the knee session survives it.',
  },
  {
    id: 'P-xiv. ★ the refresh cadence is an hour',
    file: BR,
    find: 'export const SOUNDED_CRIT_PERSIST_EVERY_MS = 60_000;',
    to: 'export const SOUNDED_CRIT_PERSIST_EVERY_MS = 3_600_000; /* MUTANT */',
    why: 'The last-present time on disk can be as old as the restore bound.',
  },

  /* ── (8) seam fixes: the fallback seed on the committed red ─────────────── */
  {
    id: 'P-xv. ★★ the seed keyed on a heard red again',
    file: BR,
    find: "      persistedCondition?.conditionLevel === 'red'",
    to: "      bootBaselineLevel === 'red' /* MUTANT */",
    why: 'The upgrade restart landing inside a hold (the heard flag demoted while the critical is muted) seeds nothing: "All clear" with the card open.',
  },

  /* ── (8) seam fixes: a green held by a sounded critical inside the warm-up ── */
  {
    id: 'Q-i. ★★★ the hold is never marked as held by a sounded critical inside the warm-up',
    file: BR,
    find: '      if (bootCritHeld && inWarmup) deescalationHold.soundedHeldInWarmup = true;',
    to: '      /* MUTANT */',
    why: 'The restored absent critical holds the green 7 min, its dwell ends as the warm-up does, and it is spoken with the set never settled.',
  },
  {
    id: 'Q-ii. ★★★ the recovery is decided inside the warm-up only',
    file: BR,
    find: "      && (questionOpen || (deescalationHold?.soundedHeldInWarmup === true", // v1.187.4 — re-pointed
    to: "      && (questionOpen || (false /* MUTANT */",
    why: 'As Q-i.',
  },
  {
    id: 'Q-iii. ★★ past the warm-up the recovery is waited for without bound',
    file: BR,
    find: '        && (recoveryHoldSinceMs == null || Date.now() - recoveryHoldSinceMs < CONDITION_CLEAR_DWELL_MS)));',
    to: '        || true)); /* MUTANT */',
    why: 'Held for its recovery past the warm-up, the green is never adopted: it waits for a settled set that may never come.',
  },
  {
    id: 'Q-iv. ★★ a sounded hold that begins after the warm-up is marked too',
    file: BR,
    find: '      if (bootCritHeld && inWarmup) deescalationHold.soundedHeldInWarmup = true;',
    to: '      if (bootCritHeld) deescalationHold.soundedHeldInWarmup = true; /* MUTANT */',
    why: 'A green held by a restored critical only after the warm-up, on an unsettled set, is adopted in silence where any green after the warm-up is spoken.',
  },
  {
    id: 'Q-v. ★★ any hold inside the warm-up is marked',
    file: BR,
    find: '      if (bootCritHeld && inWarmup) deescalationHold.soundedHeldInWarmup = true;',
    to: '      if (inWarmup) deescalationHold.soundedHeldInWarmup = true; /* MUTANT */',
    why: 'A green that begins late in the warm-up and stands its plain dwell past it is silenced instead of spoken.',
  },

  /* ── seam review: only a critical of BEFORE the restart marks the hold ─────── */
  {
    id: 'Q-vi. ★★★ a critical that sounded after the boot marks the hold (the 0682137 rule)',
    file: BR,
    find: '      if (bootCritHeld && inWarmup) deescalationHold.soundedHeldInWarmup = true;',
    to: '      if (critHeld && inWarmup) deescalationHold.soundedHeldInWarmup = true; /* MUTANT */',
    why: 'A cell-spread red heard after the restart that clears inside the warm-up is decided on one tick past it and, the set unsettled, its all-clear is adopted in silence: the cleared critical stays the last words.',
  },
  {
    id: 'Q-vii. ★★★ the restored criticals are not recorded as the boot\'s',
    file: BR,
    find: '      bootSoundedFps.add(f);',
    to: '      /* MUTANT */',
    why: 'As Q-i: no hold is ever marked.',
  },
  {
    id: 'Q-viii. ★★ a boot critical released since is still of the boot',
    file: BR,
    find: '    for (const f of [...bootSoundedFps]) if (!soundedCritFps.has(f)) bootSoundedFps.delete(f);',
    to: '    /* MUTANT */',
    why: 'Released and back loud after the restart (the replay muted), its green past the warm-up is adopted in silence on an unsettled set.',
  },
  {
    id: 'Q-ix. ★★ the boot hold is read off the whole record',
    file: BR,
    find: '      && soundedCriticalHeld(alerts, new Map([...soundedCritFps].filter(([f]) => bootSoundedFps.has(f))), tickNow);',
    to: '      && true; /* MUTANT */',
    why: 'A restored critical still in the record marks a hold that a critical of after the boot holds.',
  },

  /* ── seam review: past the warm-up the decision has the warm-up's patience ── */
  {
    id: 'Q-x. ★★ past the warm-up the recovery is decided on the due tick alone',
    file: BR,
    find: '        && (recoveryHoldSinceMs == null || Date.now() - recoveryHoldSinceMs < CONDITION_CLEAR_DWELL_MS)));',
    to: '        && recoveryHoldSinceMs == null)); /* MUTANT */',
    why: 'A settled stamp reset by one transient onset 30 s before the due tick silences the all-clear the warm-up path would have waited for.',
  },
  {
    id: 'Q-xi. ★ the patience is two dwells',
    file: BR,
    find: '        && (recoveryHoldSinceMs == null || Date.now() - recoveryHoldSinceMs < CONDITION_CLEAR_DWELL_MS)));',
    to: '        && (recoveryHoldSinceMs == null || Date.now() - recoveryHoldSinceMs < 2 * CONDITION_CLEAR_DWELL_MS))); /* MUTANT */',
    why: 'The green read from an unsettled set is held twice as long as the warm-up path would hold it.',
  },

  /* ── seam review (LOW): a condition heard after the restart is not left as the last words ── */
  {
    id: 'L-i. ★★★ the held green is adopted silently at the end of the warm-up whatever was spoken since the boot',
    file: BR,
    find: "      if (conditionAudibleSinceBootLevel != null && conditionAudibleSinceBootLevel !== 'green') {", // v1.187.4 — re-pointed
    to: '      if (false) { /* MUTANT */',
    why: 'A red heard after the restart that clears on a set that never settles keeps its green unspoken: the cleared critical stays the last words.',
  },
  {
    id: 'L-ii. ★★ the held green is always spoken at the end of the warm-up',
    file: BR,
    find: "      if (conditionAudibleSinceBootLevel != null && conditionAudibleSinceBootLevel !== 'green') {", // v1.187.4 — re-pointed
    to: '      if (true) { /* MUTANT */',
    why: 'The clear of a warning heard only before the restart is spoken from a set that never settled (the fail-quiet rule).',
  },

  /* ── (8) seam fixes: the disk keeps when a restored critical was last present ── */
  {
    id: 'D-i. ★★★ the boot stamp is written back to disk',
    file: BR,
    find: '          soundedCrit: Object.fromEntries(soundedCritKept().map(([f, at]) => [f, soundedCritRestoredAt.get(f) ?? at])), // v1.187.3 (restoreSoundedCriticals)',
    to: '          soundedCrit: Object.fromEntries(soundedCritKept()), /* MUTANT */',
    why: 'Restarts less than 7 min apart keep an absent critical restorable for ever.',
  },
  {
    id: 'D-ii. ★★★ the on-disk last-present times are not kept at the restore',
    file: BR,
    find: '    if (restored != null) for (const f of restored.keys()) soundedCritRestoredAt.set(f, Math.min((persistedSoundedCrit as Record<string, number>)[f], bootMs));',
    to: '    /* MUTANT */',
    why: 'As D-i.',
  },
  {
    id: 'D-iii. ★★ a restored critical present again keeps its old time on disk',
    file: BR,
    find: '      for (const f of [...soundedCritRestoredAt.keys()]) if (presentCrit.has(f)) soundedCritRestoredAt.delete(f);',
    to: '      for (const f of [...soundedCritRestoredAt.keys()]) if (presentCrit.has(f) && false) soundedCritRestoredAt.delete(f); /* MUTANT */',
    why: 'A critical that stands on after a restart ages out of the record and is lost at the next restart.',
  },
  {
    id: 'D-iv. ★ a last-present time from the future is written back as it was',
    file: BR,
    find: '    if (restored != null) for (const f of restored.keys()) soundedCritRestoredAt.set(f, Math.min((persistedSoundedCrit as Record<string, number>)[f], bootMs));',
    to: '    if (restored != null) for (const f of restored.keys()) soundedCritRestoredAt.set(f, (persistedSoundedCrit as Record<string, number>)[f]); /* MUTANT */',
    why: 'After the clock steps back, the entry stays restorable until the clock catches up, plus the bound.',
  },

  /* ── (8) seam fixes: only cell-spread criticals are persisted ──────────── */
  {
    id: 'K-i. ★★★ every critical is persisted',
    file: BR,
    find: "  return fingerprint.startsWith('vdiff-crit-');",
    to: '  return fingerprint.length > 0; /* MUTANT */',
    why: 'A standing critical whose fault code flips rewrites the status file on every flip and every minute; restored, it holds nothing.',
  },
  {
    id: 'K-ii. ★★ the write keeps every critical',
    file: BR,
    find: '          soundedCrit: Object.fromEntries(soundedCritKept().map(([f, at]) => [f, soundedCritRestoredAt.get(f) ?? at])), // v1.187.3 (restoreSoundedCriticals)',
    to: '          soundedCrit: Object.fromEntries([...soundedCritFps].map(([f, at]) => [f, soundedCritRestoredAt.get(f) ?? at])), /* MUTANT */',
    why: 'An inverter error that sounded is written, though it can hold nothing after a restart.',
  },
  {
    id: 'K-iii. ★★ every critical\'s set drives a write',
    file: BR,
    find: '  const soundedCritKeys = (): string => JSON.stringify(soundedCritKept().map(([f]) => f).sort());',
    to: '  const soundedCritKeys = (): string => JSON.stringify([...soundedCritFps.keys()].sort()); /* MUTANT */',
    why: 'A fault code alternating between two values writes the status file on every flip.',
  },
  {
    id: 'K-iv. ★★ the minute refresh runs while any critical stands',
    file: BR,
    find: '      || (soundedCritKept().length > 0 && tickNow - soundedCritWritten.atMs >= SOUNDED_CRIT_PERSIST_EVERY_MS)) persistStatus();',
    to: '      || (soundedCritFps.size > 0 && tickNow - soundedCritWritten.atMs >= SOUNDED_CRIT_PERSIST_EVERY_MS)) persistStatus(); /* MUTANT */',
    why: 'A standing critical of another family writes the status file every minute for as long as it stands.',
  },
  {
    id: 'K-v. ★ the restore keeps every critical',
    file: BR,
    find: '    if (!soundedCritPersists(f)) continue;',
    to: '    /* MUTANT */',
    why: 'A record holding another family\'s critical restores an entry that holds nothing.',
  },
  {
    id: 'K-vi. ★ the fallback seeds every critical of the red announcement',
    file: BR,
    find: '        ? (redReplayGate.state()?.activeFingerprints ?? []).filter((f) => soundedCritPersists(f)).map((f) => [f, bootMs])',
    to: '        ? (redReplayGate.state()?.activeFingerprints ?? []).map((f) => [f, bootMs]) /* MUTANT */',
    why: 'The boot line says an inverter error is held, though nothing holds it.',
  },

  /* ── (7) log review 10-01: an unknown NWS feed is not "no storms" ─────── */
  {
    id: 'N-i. ★★★ a failed NWS fetch with nothing cached is "no storms" again',
    file: AN,
    find: "  if (feed == null) throw new Error('NWS alerts unknown — the fetch failed and no earlier feed is cached');",
    to: '  if (feed == null) return []; /* MUTANT */',
    why: 'The storm-prep feed reads as a warm delivery and the set as settled while a warning may be in effect.',
  },
  {
    id: 'N-ii. ★★★ the failure is cached',
    file: AN,
    find: "  if (feed == null) throw new Error('NWS alerts unknown — the fetch failed and no earlier feed is cached');",
    to: "  if (feed == null) { stormPrepCache = { ts: Date.now(), value: [] }; throw new Error('NWS alerts unknown'); } /* MUTANT */",
    why: 'The next pass inside the 10-minute cache delivers [] without asking NWS.',
  },
  {
    id: 'N-iii. ★★ a successful empty fetch is unknown too',
    file: AN,
    find: "  if (feed == null) throw new Error('NWS alerts unknown — the fetch failed and no earlier feed is cached');",
    to: "  if (feed == null || feed.alerts.length === 0) throw new Error('NWS alerts unknown'); /* MUTANT */",
    why: 'A quiet sky keeps the feed cold for good: no recovery is ever spoken.',
  },

  /* ── (8) seam fixes: a failed NWS fetch is backed off, not retried every pass ── */
  {
    id: 'N-iv. ★★★ no backoff after a failed fetch',
    file: NW,
    find: '  if (nwsAlertsBackingOff(alertsFailedAt, Date.now())) return cache;',
    to: '  /* MUTANT */',
    why: 'Until NWS first answers, every 20 s monitor pass sends a request: ~180 an hour for as long as it fails.',
  },
  {
    id: 'N-v. ★★★ a failed fetch is not recorded',
    file: NW,
    find: '    alertsFailedAt = Date.now();',
    to: '    /* MUTANT */',
    why: 'As N-iv.',
  },
  {
    id: 'N-vi. ★★★ the backoff answers "no alerts"',
    file: NW,
    find: '  if (nwsAlertsBackingOff(alertsFailedAt, Date.now())) return cache;',
    to: '  if (nwsAlertsBackingOff(alertsFailedAt, Date.now())) return cache ?? { fetchedAt: Date.now(), lat: config.forecastLat, lon: config.forecastLon, alerts: [] }; /* MUTANT */',
    why: 'The storm-prep feed reads as a warm delivery of "no storms" inside the backoff, and the set as settled.',
  },
  {
    id: 'N-vii. ★★ concurrent callers each send a request',
    file: NW,
    find: '  return alertsFlight.run(() => fetchNwsAlerts(log));',
    to: '  return fetchNwsAlerts(log); /* MUTANT */',
    why: 'The monitor, the alerts route and the calendar each ask api.weather.gov at once.',
  },
  {
    id: 'N-viii. ★ a failure "in the future" holds the backoff',
    file: NW,
    find: '  return failedAtMs != null && nowMs >= failedAtMs && nowMs - failedAtMs < backoffMs;',
    to: '  return failedAtMs != null && nowMs - failedAtMs < backoffMs; /* MUTANT */',
    why: 'After the clock steps back, NWS is not asked until the clock catches up: the storm alerts stay unknown.',
  },
  {
    id: 'N-ix. ★ the backoff is zero',
    file: NW,
    find: 'export const NWS_ALERTS_FAILURE_BACKOFF_MS = 2 * 60_000;',
    to: 'export const NWS_ALERTS_FAILURE_BACKOFF_MS = 0; /* MUTANT */',
    why: 'As N-iv.',
  },
];

/** true = the tests passed; false = they ran and failed. Throws if they could not run. */
function passes(cmd, args) {
  try {
    execFileSync(cmd, args, { cwd: SERVER, stdio: 'ignore' });
    return true;
  } catch (e) {
    if (typeof e?.status === 'number' && e?.signal == null) return false;
    throw e;
  }
}
const subsetPasses = () => passes('node', ['--import', 'tsx', '--test', ...SUBSET]);
const fullPasses = () => passes('npm', ['test', '--silent']);

const originals = new Map();
for (const m of MUTANTS) if (!originals.has(m.file)) originals.set(m.file, readFileSync(m.file, 'utf8'));
const restoreAll = () => { for (const [f, s] of originals) writeFileSync(f, s); };

for (const [f, s] of originals) {
  if (s.includes('/* MUTANT')) {
    console.error(`\nABORT: ${f} already contains a mutant marker — restore it first.`);
    process.exit(2);
  }
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { restoreAll(); console.error(`\ninterrupted (${sig}) — tree restored`); process.exit(130); });
}
for (const m of MUTANTS) {
  const hits = originals.get(m.file).split(m.find).length - 1;
  if (hits !== 1) {
    console.error(`\nABORT: anchor for "${m.id}" matched ${hits} times, expected exactly 1.`);
    process.exit(2);
  }
}
if (!subsetPasses()) {
  console.error('\nABORT: the subset fails on the UNMUTATED tree. Fix the baseline first.');
  process.exit(2);
}

let fullBaselineChecked = false;
let killed = 0;
const survivors = [];
console.log(`mutate-v1187-3h: ${MUTANTS.length} mutants against ${SUBSET.join(' + ')}\n`);

try {
  for (const m of MUTANTS) {
    const original = originals.get(m.file);
    const mutated = original.replace(m.find, m.to);
    writeFileSync(m.file, mutated);
    let died = !subsetPasses();
    if (!died) {
      if (!fullBaselineChecked) {
        writeFileSync(m.file, original);
        const ok = fullPasses();
        writeFileSync(m.file, mutated);
        fullBaselineChecked = true;
        if (!ok) {
          console.error('\nABORT: the full suite fails on the UNMUTATED tree, so it cannot count a kill.');
          restoreAll();
          process.exit(2);
        }
      }
      died = !fullPasses();
    }
    writeFileSync(m.file, original);
    if (died) { killed++; console.log(`  KILLED   ${m.id}`); }
    else { survivors.push(m); console.log(`  SURVIVED ${m.id}\n           ↳ ${m.why}`); }
  }
} finally {
  restoreAll();
}

console.log(`\n${killed}/${MUTANTS.length} mutants killed`);
if (survivors.length) {
  console.log('\nSURVIVORS — the suite does not constrain these behaviours:');
  for (const s of survivors) console.log(`  - ${s.id}\n      ${s.why}`);
  process.exit(1);
}
console.log('post-run: tree restored');
