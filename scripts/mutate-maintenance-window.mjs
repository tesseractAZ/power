#!/usr/bin/env node
/**
 * mutate-maintenance-window.mjs — v1.197.0: the per-Core maintenance window (maintenanceWindow.ts).
 * One Core's own alerts are held (no push, no broadcast) for 15 min to 4 h; every pool, panel and
 * plant-level alarm still sounds; an overheating pack, a cell at the over-voltage line and a defective
 * pack page from a shelved Core as from anywhere. The stamp sits on the alert monitor's one chokepoint
 * (assemble), which feeds both the push gate and the broadcast, so a defect here silences a real alarm.
 *
 *   Scope      i..iv     (the allowlist, never-muted first, whole-segment serials, Cores only)
 *   Time       v..ix     (stamp-time expiry, the start limit, the extension cap, the clock stepped back,
 *                         the early end only after an abnormal tick)
 *   Fail-closed x..xiii  (a failed save, an over-limit record at load, the gap absorption's limit,
 *                         the home pool keeps one Core)
 *   Loud       xiv..xvi  (the all-clear gate, the stamp in the monitor, the end push)
 *   Review     xvii..xxvii (v1.197.0 review: a held alert is not boot-seeded; the boot end push knows
 *                         what is still active; the home guard's stable set; an absorbed gap keeps its
 *                         window; a lapsed window is settled before a start; an unsaved end removes
 *                         the file; the call sites in the monitor; Home Assistant's End-all button)
 *   Owed       xxviii..xxxix (v1.197.0 integration review: the all-clear a shelved critical holds back
 *                         is owed, not dropped — owed at the gate, the spoken retry, the storm-gated
 *                         re-present and the deferred retry, held while a shelved critical stands, the
 *                         flicker dwell, dropped behind the reserve floor, a settled set after a
 *                         restart, the record and its age, cancelled by a commit)
 *
 *   node scripts/mutate-maintenance-window.mjs
 *
 * ★ Every mutation is ANCHOR-ASSERTED: if `find` is not present exactly once the harness ABORTS
 *   rather than reporting a green run against an unmutated tree.
 * ★ A harness run is only evidence if the BASELINE was green — confirm `0 fail`.
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = resolve(REPO, 'server');
const MW = resolve(SERVER, 'src/maintenanceWindow.ts');
const BC = resolve(SERVER, 'src/broadcast.ts');
const AM = resolve(SERVER, 'src/alertMonitor.ts');
const MQ = resolve(SERVER, 'src/mqttDiscovery.ts');

const SUBSET = ['test/maintenanceWindow.test.ts', 'test/maintenanceWiring.test.ts', 'test/maintenanceMqtt.test.ts', 'test/maintenanceOwedAllClear.test.ts'];

const MUTANTS = [
  {
    id: 'i. ★★★ the allowlist is bypassed — any alert naming the device is shelvable',
    file: MW,
    find: '  return MAINTENANCE_SHELVABLE_PREFIXES.some((p) => a.id.startsWith(p));',
    to: '  return true; /* MUTANT */',
    why: 'A window naming a panel shelves shp2-below-reserve-<panel> and backup-soc-<pct>-<panel>: the pool alarms of the second panel go quiet.',
  },
  {
    id: 'ii. ★★★ the never-muted exemption is dropped',
    file: MW,
    find: '  if (isNeverMutedAlert(a)) return false;\n  return MAINTENANCE_SHELVABLE_PREFIXES',
    to: '  /* MUTANT */\n  return MAINTENANCE_SHELVABLE_PREFIXES',
    why: 'An overheating pack (temp-…-critical) on the shelved Core goes silent for up to 4 h.',
  },
  {
    id: 'iii. ★★ a serial matches as a substring, not a whole id segment',
    file: MW,
    find: "  return a.id.split('-').includes(sn);",
    to: '  return a.id.includes(sn); /* MUTANT */',
    why: 'A Core whose serial is a prefix of another serial shelves the other Core too.',
  },
  {
    id: 'iv. ★★★ the stamp applies windows on any device, not only Cores',
    file: MW,
    find: '  return ws.filter((w) => isCoreDevice(devices[w.sn]));',
    to: '  return [...ws]; /* MUTANT */',
    why: "A forged window naming the panel holds the panel's own offline and stale alerts — the evidence that the pool alarms' data is frozen.",
  },
  {
    id: 'v. ★★★ the stamp-time expiry is dropped',
    file: MW,
    find: 'now >= w.startedAtMs - MAINT_CLOCK_BACK_TOL_MS && now < w.untilMs && withinLimit(w);',
    to: 'now >= w.startedAtMs - MAINT_CLOCK_BACK_TOL_MS && withinLimit(w); /* MUTANT */',
    why: 'A window whose step stalls (a wedged tick, a thrown observe) shelves the Core past its end.',
  },
  {
    id: 'vi. ★★★ the hard limit is not enforced at the start',
    file: MW,
    find: '  if (p.durationMs > MAINT_MAX_MS) {',
    to: '  if (false) { /* MUTANT */',
    why: 'A 9 h window is accepted (the stamp would then hold nothing, but the card and the push say otherwise).',
  },
  {
    id: 'vii. ★★ an extension runs past the window start + 4 h',
    file: MW,
    find: '    const untilMs = Math.min(p.nowMs + p.durationMs, limitMs);',
    to: '    const untilMs = p.nowMs + p.durationMs; /* MUTANT */',
    why: 'Repeated extensions keep one Core shelved indefinitely without a new start push.',
  },
  {
    id: 'viii. ★★ the clock-stepped-back end is removed',
    file: MW,
    find: "  if (now < w.startedAtMs - MAINT_CLOCK_BACK_TOL_MS) return 'clock-stepped-back';",
    to: "  if (false) return 'clock-stepped-back'; /* MUTANT */",
    why: 'On the RTC-less host a backward step leaves a window open, to be stretched beyond 4 h of wall time.',
  },
  {
    id: 'ix. ★★ the early end needs no abnormal tick',
    file: MW,
    find: '        if (w.abnormalSeenAtMs != null && w.normalSinceMs != null && now - w.normalSinceMs >= returnDwellMs) {',
    to: '        if (w.normalSinceMs != null && now - w.normalSinceMs >= returnDwellMs) { /* MUTANT */',
    why: 'A window ends 15 min after it starts on a still-healthy Core, mid-job: the 08-20 noise returns.',
  },
  {
    id: 'x. ★★★ a failed save still shelves',
    file: MW,
    find: "        return { ok: false, code: 500, error: 'could not save the window; nothing is shelved' };",
    to: '        /* MUTANT */',
    why: 'A window that is not on disk is in force now but gone after a restart — and the API answered as if both held.',
  },
  {
    id: 'xi. ★★ an over-limit record loads open',
    file: MW,
    find: "    const reason: MaintenanceEndReason | null = !withinLimit(w) ? 'over-limit'",
    to: "    const reason: MaintenanceEndReason | null = false ? 'over-limit' /* MUTANT */",
    why: 'A forged or corrupt 9 h record loads as a window in force, and no end push is ever owed for it.',
  },
  {
    id: 'xii. ★★ the gap absorption ignores the limit',
    file: MW,
    find: '  if (!withinLimit(w)) return false;',
    to: '    /* MUTANT */',
    why: 'A forged window with a wide span absorbs every telemetry-gap push of that Core for a day.',
  },
  {
    id: 'xiii. ★★ the home pool is left with no Core that keeps its alarms',
    file: MW,
    find: '    if (others.length > 0 && others.every((sn) => shelved.has(sn))) {',
    to: '    if (false) { /* MUTANT */',
    why: 'Every home Core can be shelved at once: no Core-level alarm of the house pool is heard.',
  },
  {
    id: "xiv. ★★★ 'All clear' is spoken with a shelved critical open",
    file: BC,
    find: ' || a.shelvedUntilMs != null));',
    to: ')); /* MUTANT */',
    why: '"All clear. All stations report normal." is spoken while a critical stands, held, on the card.',
  },
  {
    id: 'xv. ★★★ the monitor never stamps (the window is decoration)',
    file: AM,
    find: '        applyMaintenanceMute(a, maintWindows, maintNow);',
    to: '        /* MUTANT */',
    why: 'The card says shelved, the start push says shelved, and every rise is pushed and announced.',
  },
  {
    id: 'xvi. ★★★ the end push is never sent (held alerts are lost)',
    file: MW,
    find: '    push(renderEndPush(w, { stillActive }, deps.fmtClock));',
    to: '    /* MUTANT */',
    why: 'Everything the window held — titles, criticals, settings changed — is never reported.',
  },
  {
    id: 'xvii. ★★★ a held warning is boot-seeded as already pushed',
    file: AM,
    find: '  if (p.heldByMaintenance === true) return p.alreadyNotified;',
    to: '  /* MUTANT */',
    why: 'A window spanning one of the daily restarts swallows every warning it held: the end push says "pushed and announced from now on" and nothing is pushed.',
  },
  {
    id: 'xviii. ★★ the end push of a window ended while down does not know what is still active',
    file: MW,
    find: '      for (const e of owed) onEnded(e, devices != null ? alerts : null);',
    to: '      for (const e of owed) onEnded(e, null); /* MUTANT */',
    why: 'The end push after a restart lists nothing as still active, though the Core\'s alerts stand.',
  },
  {
    id: 'xix. ★★★ the home guard forgets a shelved Core that left the roster',
    file: MW,
    find: '  const home = new Set([...p.homePoolSns, ...inForce.filter((w) => w.homeAtStart).map((w) => w.sn)]);',
    to: '  const home = new Set(p.homePoolSns); /* MUTANT */',
    why: 'Core 3 shelved and unplugged for re-wiring, the last home Core can be shelved too: no home Core keeps its alarms.',
  },
  {
    id: 'xx. ★★ the home set drops a Core the panel lists on a disconnected slot',
    file: MW,
    find: '  for (const [sn, d] of Object.entries(devices)) if (isCoreDevice(d) && slotOfDpu(devices, sn) != null) out.add(sn);',
    to: '  /* MUTANT */',
    why: 'A target Core momentarily off the live roster skips the guard entirely.',
  },
  {
    id: 'xxi. ★★ an ended window is pruned while a gap it absorbs still stands',
    file: MW,
    find: '      if (obs.alerts.some((a) => isDeviceGapAlertId(a.id) && absorbsGap(w0, a))',
    to: "      if (obs.alerts.some((a) => isDeviceGapAlertId(a.id) && absorbsGap(w0, a) && a.id === '') /* MUTANT */",
    why: 'The telemetry gap of a Core worked on (filed 6 h into the darkness) is pushed a day late, as if it were news.',
  },
  {
    id: 'xxii. ★★★ a window lapsed since the last step is not settled before a start',
    file: MW,
    find: '      settleLapsed(now, req.alerts);',
    to: '      /* MUTANT */',
    why: 'A start in the seconds after a window ran out opens a second window beside it; End now then ends the stale one while the new one holds.',
  },
  {
    id: 'xxiii. ★★★ an end that cannot be saved leaves the stale file',
    file: MW,
    find: '          remove(deps.path);',
    to: '          /* MUTANT */',
    why: 'After End now on a full disk, a restart shelves the Core again although its end push said its alarms are live.',
  },
  {
    id: 'xxiv. ★★★ the monitor applies windows on any device, not only Cores',
    file: AM,
    find: '    const maintWindows = windowsOnCores(deps.maintenance?.windows() ?? [], snap.devices);',
    to: '    const maintWindows = [...(deps.maintenance?.windows() ?? [])]; /* MUTANT */',
    why: "A forged or corrupt record naming the panel holds the panel's own offline, stale and gap alerts.",
  },
  {
    id: 'xxv. ★★★ the step never sees the device map',
    file: AM,
    find: '        deps.maintenance.observe(alerts, storeHydrated() ? snap.devices : null, maintNow);',
    to: '        deps.maintenance.observe(alerts, null, maintNow); /* MUTANT */',
    why: 'Neither the return to normal nor a removed Core ends a window: every Core stays shelved its full span.',
  },
  {
    id: "xxvi. ★★★ Home Assistant's End All Maintenance ends nothing",
    file: MQ,
    find: '        const n = maintenance.endAll();',
    to: '        const n = 0; /* MUTANT */',
    why: 'The button is pressed, the log says it ran, and every Core stays shelved for up to 4 h.',
  },
  {
    id: "xxvii. ★★★ the End-all command topic is never subscribed",
    file: MQ,
    find: '        client.subscribe(MAINTENANCE_END_ALL_TOPIC, { qos: 0 }, (err) => {',
    to: '        if (false) client.subscribe(MAINTENANCE_END_ALL_TOPIC, { qos: 0 }, (err) => { /* MUTANT */',
    why: 'The button is in Home Assistant but the broker never forwards its press.',
  },
  {
    id: 'xxviii. ★★★ the all-clear a shelved critical holds back is dropped, not owed',
    file: BC,
    find: "      oweShelvedAllClear(shelvedCriticalStands(alerts), 'green adopted silently');",
    to: '      /* MUTANT */',
    why: 'A red heard, its Core shelved, the fault fixed inside the window: "All clear" is never said, and the last words in the house stay a red that has cleared.',
  },
  {
    id: 'xxix. ★★★ the owed all-clear is never said',
    file: BC,
    find: "? { action: 'speak' } : { action: 'wait', openSinceMs };",
    to: "? { action: 'wait', openSinceMs } : { action: 'wait', openSinceMs }; /* MUTANT */",
    why: 'The all-clear is owed and on record, and nothing ever says it.',
  },
  {
    id: 'xxx. ★★ no flicker guard: the owed all-clear is said the tick the gate opens',
    file: BC,
    find: 'p.nowMs - from >= (p.dwellMs ?? CONDITION_CLEAR_DWELL_MS)',
    to: 'p.nowMs - from >= 0 /* MUTANT */',
    why: 'The held critical missing from one publish says "All clear", and the fault is still on the card the next tick.',
  },
  {
    id: 'xxxi. ★★★ a shelved critical does not hold the owed all-clear (dropped behind it)',
    file: BC,
    find: "  if (p.level !== 'green' || p.shelved) return { action: 'wait', openSinceMs: null };",
    to: "  if (p.level !== 'green') return { action: 'wait', openSinceMs: null }; /* MUTANT */",
    why: 'The first tick after the green commits drops the all-clear behind the very critical that made it owed.',
  },
  {
    id: "xxxii. ★★★ 'All clear' over the reserve floor once the shelved critical clears",
    file: BC,
    find: "  if (p.blocked) return { action: 'drop',",
    to: "  if (false) return { action: 'drop', /* MUTANT */",
    why: '"All clear. All stations report normal." while the runway alarm announces a critical at the reserve floor on the same speakers.',
  },
  {
    id: "xxxiii. ★★★ a restored owed all-clear is said on an unsettled set",
    file: BC,
    find: '  if (p.restored && p.settledSinceMs == null) return { action: \'wait\', openSinceMs };',
    to: '  /* MUTANT */',
    why: 'After a restart inside the window, the empty boot store reads green with no shelved critical in it: "All clear" over a fault still shelved.',
  },
  {
    id: 'xxxiv. ★★ the owed all-clear is not written with the record',
    file: BC,
    find: 'shelvedAllClearOwedAt: shelvedAllClearOwed?.sinceMs ?? null, // v1.197.0 (review) (restoredShelvedAllClear)',
    to: 'shelvedAllClearOwedAt: null, /* MUTANT */',
    why: 'The host restarts daily: a restart inside the window loses the owed all-clear, and with it the last words.',
  },
  {
    id: 'xxxv. ★★ a commit does not cancel the owed all-clear',
    file: BC,
    find: '    shelvedAllClearOwed = null; // cancelled by the commit',
    to: '    /* MUTANT */',
    why: 'A red committed at the window\'s end leaves the old owed all-clear on record: after a restart it is said for a level the house has since left.',
  },
  {
    id: "xxxvi. ★★ the all-clear's spoken retry gated by a shelved critical is dropped",
    file: BC,
    find: "      if (allClearGated && levelOk) oweShelvedAllClear(shelvedCriticalStands(alerts), 'the all-clear\\'s spoken retry gated');",
    to: '      /* MUTANT */',
    why: 'The all-clear sounded as the tone alone; its words, held back by a critical shelved in the 90 s before the retry, are never said.',
  },
  {
    id: 'xxxvii. ★ an owed all-clear of any age is resumed after a restart',
    file: BC,
    find: '  if (at < bootMs - maxAgeMs) return null;',
    to: '  /* MUTANT */',
    why: 'A record days old says "All clear" at the next boot, for a window long over.',
  },
  {
    id: "xxxviii. ★★ a storm-gated all-clear's re-present held back by a shelved critical is dropped",
    file: BC,
    find: "          if (held.level === 'green' && level === 'green' && cfg.enabled) oweShelvedAllClear(shelvedCriticalStands(alerts), `the ${deferredName(held)} gated`);",
    to: '          /* MUTANT */',
    why: 'The all-clear the storm gate refused 90 s after the red is never re-presented once a Core faults and is shelved in the gap: the red stays the last words.',
  },
  {
    id: "xxxix. ★★ an all-clear's deferred retry held back by a shelved critical is dropped",
    file: BC,
    find: "      if (w.action === 'drop') return { drop: w.reason, shelvedGate: level === 'green' && shelvedCriticalStands(speakable) };",
    to: "      if (w.action === 'drop') return { drop: w.reason }; /* MUTANT */",
    why: 'The all-clear that failed at the speakers is never retried once a Core is shelved before its retry: nobody heard it.',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs).
// fullSuite: false — the subset holds every test that guards these mutants, so a kill comes
// from the subset.
import { runMutantsParallel } from './lib/mutateParallel.mjs';
// typecheck: true — a mutant that does not compile is reported INVALID, never counted as a kill.
await runMutantsParallel({ name: 'mutate-maintenance-window', mutants: MUTANTS, subset: SUBSET, root: REPO, fullSuite: false, typecheck: true });
