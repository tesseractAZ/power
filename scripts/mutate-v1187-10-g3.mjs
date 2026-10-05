#!/usr/bin/env node
/**
 * mutate-v1187-10-g3.mjs — committed harness for v1.187.10, group 3 (alarms, 10-03 log review).
 *
 *  H.  A home Core listed OFFLINE by the cloud while its own MQTT data still arrives is held
 *      non-annunciating for its onset (alerts.cloudOfflineOnsetHeld: 3 min from the transition, and
 *      only while a data message landed within 90 s). Silent on MQTT, or past the hold, it alarms.
 *      The panel is never held (its MQTT never reaches its projection, so its alarm inputs are frozen).
 *  V.  The spoken text reads no API path ("/device/list"), no "message s" and no "31s".
 *  C1. A timed-out cordless dispatch to an entity that reports no playback is delivery UNKNOWN —
 *      never counted as audible; the restart decisions wait for an armed condition retry.
 *  C14. The boot-yellow drop line names a held warning still present as "still active", not cleared.
 *  C26. The cleared ledger keeps its newest info rows (reserve) and never evicts a pushed row in the
 *      noise tiers; the cap note says what each new clear evicts.
 *  C28. The rate-floor card freezes its onset and says "recovering"; a roster-muted collapse logs INFO.
 *  C29. The blind-hold end line claims no cause; the stale-shadow latch setting logs at warn.
 *  C34. Every broadcast outcome line names its kind and generation.
 *
 * Each mutant runs its own test files first (the full restart file takes ~105 s, so the C1 mutants
 * run its cordless / v1.187.10 tests only); a survivor is re-judged by the full suite.
 *
 * Not mutated: the null guard in cloudOfflineOnsetHeld for a missing transition (removing it leaves
 * `nowMs - undefined` = NaN, which fails `>= 0`: an equivalent mutant); the `>` level comparison in
 * conditionRetryCouldRaise (a retry at the decision's own level cannot change it, and no retry of a
 * level equal to the one decided is armed in the restart window); the labelled source pins of
 * index.ts and startPollLoop wiring beyond one mutant each.
 *
 *   node scripts/mutate-v1187-10-g3.mjs
 *
 * ★ Anchor-asserted; a red baseline aborts; restores in a finally block and on SIGINT/SIGTERM/SIGHUP;
 *   refuses to start over a leftover mutant marker.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = resolve(REPO, 'server');
const AL = resolve(SERVER, 'src/alerts.ts');
const BR = resolve(SERVER, 'src/broadcast.ts');
const AM = resolve(SERVER, 'src/alertMonitor.ts');
const RF = resolve(SERVER, 'src/messageRateFloorAlert.ts');
const BL = resolve(SERVER, 'src/blindRemediation.ts');
const SS = resolve(SERVER, 'src/snapshot.ts');
const IX = resolve(SERVER, 'src/index.ts');
const TT = resolve(SERVER, 'src/ttsService.ts');

const HOLD = ['test/cloudOfflineOnsetHold.test.ts'];
const TTS = ['test/cloudOfflineOnsetHold.test.ts', 'test/ttsVerbalize.test.ts'];
const RESTART = ['--test-name-pattern=v1\\.187\\.10|cordless|too fast', 'test/restartRecoveryAllClear.test.ts'];
const BOOT = ['test/broadcastBootHoldLog.test.ts'];
const LEDGER = ['test/clearedLedgerRetention.test.ts', 'test/v1187_10Wiring.test.ts', 'test/auditF7toF12.test.ts'];
const RATE = ['test/messageRateFloorV1187_10.test.ts', 'test/v1187_10Wiring.test.ts', 'test/selfHealIdleQuorum.test.ts'];
const BLIND = ['test/blindRemediation.test.ts', 'test/shadowLatchWarn.test.ts'];

const MUTANTS = [
  // ── H: the onset hold ──
  { id: 'H-i. ★★★ no onset hold', file: AL, tests: HOLD,
    find: '  const onsetHeld = !spare && isCore && cloudOfflineOnsetHeld(d.onlineChangedAtMs, conn?.lastMqttAt, now);',
    to: '  const onsetHeld = false; /* MUTANT */',
    why: 'THE DEFECT: a cloud blip while the data still flows is spoken on every speaker and pushed (10-03 19:31).' },
  { id: 'H-ii. ★★★ MQTT liveness not read', file: AL, tests: HOLD,
    find: '  return offlineForMs >= 0 && offlineForMs < CLOUD_OFFLINE_ONSET_HOLD_MS && nowMs - lastMqttAt < CLOUD_OFFLINE_MQTT_LIVE_MS;',
    to: '  return offlineForMs >= 0 && offlineForMs < CLOUD_OFFLINE_ONSET_HOLD_MS; /* MUTANT */',
    why: 'FAIL-QUIET: a Core offline and silent on MQTT is held 3 minutes before anyone is told.' },
  { id: 'H-iii. ★★★ the hold never ends while data arrives', file: AL, tests: HOLD,
    find: '  return offlineForMs >= 0 && offlineForMs < CLOUD_OFFLINE_ONSET_HOLD_MS && nowMs - lastMqttAt < CLOUD_OFFLINE_MQTT_LIVE_MS;',
    to: '  return offlineForMs >= 0 && nowMs - lastMqttAt < CLOUD_OFFLINE_MQTT_LIVE_MS; /* MUTANT */',
    why: 'A flag that persists is never spoken or pushed as long as some MQTT data trickles in.' },
  { id: 'H-iv. ★★ the live window includes 90 s of silence (<=)', file: AL, tests: HOLD,
    find: '  return offlineForMs >= 0 && offlineForMs < CLOUD_OFFLINE_ONSET_HOLD_MS && nowMs - lastMqttAt < CLOUD_OFFLINE_MQTT_LIVE_MS;',
    to: '  return offlineForMs >= 0 && offlineForMs < CLOUD_OFFLINE_ONSET_HOLD_MS && nowMs - lastMqttAt <= CLOUD_OFFLINE_MQTT_LIVE_MS; /* MUTANT */',
    why: 'The fail-loud boundary drifts: a device silent for the whole window still holds.' },
  { id: 'H-v. ★★ a future-stamped transition is an onset', file: AL, tests: HOLD,
    find: '  return offlineForMs >= 0 && offlineForMs < CLOUD_OFFLINE_ONSET_HOLD_MS && nowMs - lastMqttAt < CLOUD_OFFLINE_MQTT_LIVE_MS;',
    to: '  return offlineForMs < CLOUD_OFFLINE_ONSET_HOLD_MS && nowMs - lastMqttAt < CLOUD_OFFLINE_MQTT_LIVE_MS; /* MUTANT */',
    why: 'A clock step that puts the transition ahead of now holds the alert for the step plus 3 minutes.' },
  { id: 'H-vi. ★★★ the panel is held', file: AL, tests: HOLD,
    find: '  const onsetHeld = !spare && isCore && cloudOfflineOnsetHeld(d.onlineChangedAtMs, conn?.lastMqttAt, now);',
    to: '  const onsetHeld = !spare && (isCore || isPanel) && cloudOfflineOnsetHeld(d.onlineChangedAtMs, conn?.lastMqttAt, now); /* MUTANT */',
    why: 'FAIL-QUIET: the alarm data source is silent up to 3 minutes while its pool, reserve and grid status are frozen (panel MQTT never reaches its projection).' },
  { id: 'H-vii. ★ a peripheral is stamped', file: AL, tests: HOLD,
    find: '  const onsetHeld = !spare && isCore && cloudOfflineOnsetHeld(d.onlineChangedAtMs, conn?.lastMqttAt, now);',
    to: '  const onsetHeld = !spare && cloudOfflineOnsetHeld(d.onlineChangedAtMs, conn?.lastMqttAt, now); /* MUTANT */',
    why: 'The panel is held, and an info card carries a mute reason it never needed (and reads as muted on screen).' },
  { id: 'H-viii. ★★ the hold overrides a bench spare\'s reason', file: AL, tests: HOLD,
    find: '  const onsetHeld = !spare && isCore && cloudOfflineOnsetHeld(d.onlineChangedAtMs, conn?.lastMqttAt, now);',
    to: '  const onsetHeld = isCore && cloudOfflineOnsetHeld(d.onlineChangedAtMs, conn?.lastMqttAt, now); /* MUTANT */',
    why: 'A bench spare reads "onset hold" for three minutes, then "bench spare" — the reason flips under the operator.' },
  { id: 'H-ix. ★★★ held, but still annunciating', file: AL, tests: HOLD,
    find: '        ...(onsetHeld ? { annunciate: false, muteReason: MUTE_REASON_CLOUD_OFFLINE_MQTT_LIVE } : {}),',
    to: '        ...(onsetHeld ? { muteReason: MUTE_REASON_CLOUD_OFFLINE_MQTT_LIVE } : {}), /* MUTANT */',
    why: 'The card says it is held while the blip is spoken and pushed anyway.' },
  // ── V: the spoken text ──
  { id: 'V-i. ★★ "message(s)" read as "message s"', file: TT, tests: TTS,
    find: '    .replace(/\\b([A-Za-z]+)\\(s\\)/g, \'$1s\')',
    to: '    /* MUTANT */',
    why: 'The 10-03 19:31 announcement: "MQTT message s".' },
  { id: 'V-ii. ★★ an API path is read with its slashes', file: TT, tests: TTS,
    find: '    .replace(/(^|\\s)\\/([A-Za-z][\\w-]*(?:\\/[\\w-]+)*)/g, (_m, pre: string, path: string) => `${pre}${path.split(\'/\').join(\' \')}`)',
    to: '    /* MUTANT */',
    why: 'The 10-03 19:31 announcement read "/device/list" aloud.' },
  { id: 'V-iii. ★ a glued seconds age is read as "31s"', file: TT, tests: TTS,
    find: '    .replace(/\\b(\\d+)s\\b/g, \'$1 seconds\')',
    to: '    /* MUTANT */',
    why: '"last data 31s ago" is spoken letter by letter.' },
  { id: 'V-iv. ★ "1 seconds"', file: TT, tests: TTS,
    find: '(hour|minute|second|month|day|week|year)s\\b/g, \'1 $1\')',
    to: '(hour|minute|month|day|week|year)s\\b/g, \'1 $1\') /* MUTANT */',
    why: 'The singular is not restored.' },
  // ── C1: the cordless timeout probe ──
  { id: 'C1-i. ★★★ an unknown cordless delivery counts as audible', file: BR, tests: RESTART,
    find: 'log(sipProbeUnknownLine(cfg.sipTargets, states));',
    to: "{ if (kind === 'condition') noteConditionAudible(level, episode); log(sipProbeUnknownLine(cfg.sipTargets, states)); } /* MUTANT */",
    why: 'An idle reading — no evidence either way — is counted as heard.' },
  { id: 'C1-ii. ★★ the restart decision does not wait for an armed retry', file: BR, tests: RESTART,
    find: "if (realAudibleInFlight > 0 || sipOutcomesPending > 0 || conditionRetryCouldRaise('green')) {",
    to: 'if (realAudibleInFlight > 0 || sipOutcomesPending > 0) { /* MUTANT */',
    why: 'Decided between the probe and the retry, the red the retry then delivers stays the last words.' },
  { id: 'C1-iii. ★★ the continuation does not wait for an armed retry', file: BR, tests: RESTART,
    find: 'if (realAudibleInFlight > 0 || sipOutcomesPending > 0 || conditionRetryCouldRaise(level)) return;',
    to: 'if (realAudibleInFlight > 0 || sipOutcomesPending > 0) return; /* MUTANT */',
    why: 'The yellow under a red the retry then delivers is filed as the pre-restart advisory.' },
  { id: 'C1-iv. ★★ waits for a retry that cannot change the decision', file: BR, tests: RESTART,
    find: '    && (conditionAudibleSinceBootLevel == null || LEVEL_RANK[conditionAudibleSinceBootLevel] <= LEVEL_RANK[above]);',
    to: '    ; /* MUTANT */',
    why: 'A red already audible still holds the restart decision for its whole retry budget.' },
  // ── C14 / C34: broadcast log lines ──
  { id: 'C14-i. ★★ a still-present held warning reads "cleared"', file: BR, tests: BOOT,
    find: '    const a = alerts.find((x) => alertFingerprint(x) === fp);',
    to: '    const a = undefined as Alert | undefined; void alertFingerprint; /* MUTANT */',
    why: 'The 10-02/10-03 boot lines: an off-panel imbalance that never cleared is logged as cleared.' },
  { id: 'C14-ii. ★★ the drop line is judged against no alerts', file: BR, tests: BOOT,
    find: 'bootYellowDropLine(Math.round((Date.now() - bootYellowHold.sinceMs) / 1000), bootYellowHold.fps, (store.get().alerts ?? []) as Alert[])',
    to: 'bootYellowDropLine(Math.round((Date.now() - bootYellowHold.sinceMs) / 1000), bootYellowHold.fps, []) /* MUTANT */',
    why: 'The wiring: every drop reads "cleared" again.' },
  { id: 'C34-i. ★★ the success line carries no kind or generation', file: BR, tests: BOOT,
    find: "+tts' : ''})${kindTag}`);",
    to: "+tts' : ''})`); /* MUTANT */",
    why: 'The night-charge notice logs as a condition yellow; a retry matches its announcement only by timing.' },
  { id: 'C34-ii. ★★ the retry does not carry its announcement\'s generation', file: BR, tests: BOOT,
    find: '    const kindTag = outcomeTag(kind, generation);',
    to: '    const kindTag = outcomeTag(kind, ++broadcastGeneration); /* MUTANT */',
    why: 'Each outcome line names a fresh number: the retry cannot be matched.' },
  // ── C26: the cleared ledger ──
  { id: 'C26-i. ★★★ no info reserve', file: AM, tests: LEDGER,
    find: "  if (infoRows > Math.floor(logArr.length / CLEARED_INFO_RESERVE_DIVISOR) && evictOldest((_e, i) => sev(i) === 'info')) return;",
    to: "  if (evictOldest((_e, i) => sev(i) === 'info')) return; void infoRows; /* MUTANT */",
    why: 'At the cap with no info row left, every info clear is the row it evicts (85 days, 0 info rows).' },
  { id: 'C26-ii. ★★★ a pushed noise row leaves in the noise tier', file: AM, tests: LEDGER,
    find: 'e.pushed !== true && !evidence(e))) return; // v1.187.10',
    to: '!evidence(e))) return; /* MUTANT */',
    why: 'The window\'s only push leaves on its own arrival while 85-day-old rows stay.' },
  { id: 'C26-iii. ★★ a reserved info row outlives a critical', file: AM, tests: LEDGER,
    find: "  // v1.187.10 — the reserved info rows, before any critical.\n  if (evictOldest((_e, i) => sev(i) === 'info')) return;\n",
    to: '  /* MUTANT */\n',
    why: 'With no warning left, the oldest CRITICAL leaves before an info row.' },
  { id: 'C26-iv. ★★ the cap note says only "older records are being dropped"', file: AM, tests: LEDGER,
    find: "    const saturated = clearedLog.length >= CLEARED_LOG_MAX ? clearedLedgerCapNote(clearedLog, CLEARED_LOG_MAX, Date.now()) : '';",
    to: "    const saturated = clearedLog.length >= CLEARED_LOG_MAX ? ` [AT CAP ${CLEARED_LOG_MAX} — older records are being dropped]` : ''; /* MUTANT */",
    why: 'The boot line misdescribes what a full ledger drops.' },
  { id: 'C26-v. ★★★ pushed noise reaches the ordinary tier ahead of nothing: evidence goes first', file: AM, tests: LEDGER,
    find: "  if (evictOldest((e, i) => sev(i) === 'warning' && ordinary(e) && !evidence(e))) return;\n",
    to: '  /* MUTANT */\n',
    why: 'The review\'s log: an older warranty-evidence warning is evicted while five pushed noise rows stay.' },
  { id: 'C26-vi. ★★ the evidence-sparing tier ignores never-muted', file: AM, tests: LEDGER,
    find: "  if (evictOldest((e, i) => sev(i) === 'warning' && ordinary(e) && !evidence(e))) return;\n",
    to: "  if (evictOldest((e, i) => sev(i) === 'warning' && !evidence(e))) return; /* MUTANT */\n",
    why: 'A never-muted warning (cell-ovp, critical Thermal) leaves ahead of ordinary evidence-bearing warnings.' },
  // ── C28: the rate-floor card and line ──
  { id: 'C28-i. ★★ the tick does not publish its roster mute', file: AM, tests: RATE,
    find: '    lastRosterMute = { muted, spares: mutedSpareSns }; // v1.187.10 — rosterMuteReasonForSn',
    to: '    /* MUTANT */',
    why: 'An off-panel Core\'s collapse logs a WARN telling the operator to check the cloud and power.' },
  { id: 'C28-ii. ★★★ the onset follows the live rate', file: RF, tests: RATE,
    find: '  if (onset == null) {',
    to: '  if (true) { /* MUTANT */',
    why: 'The closing card reads "fell to 27.0 msg/min against ~25" — the recovered rate as the onset.' },
  { id: 'C28-iii. ★★★ never "recovering"', file: RF, tests: RATE,
    find: 'return { sn, deviceName, rate, baseline, onset, recovering: !starvedNow };',
    to: 'return { sn, deviceName, rate, baseline, onset, recovering: false }; /* MUTANT */',
    why: 'THE DEFECT: "collapsed to 27.0 msg/min, far below its learned ~25".' },
  { id: 'C28-iv. ★★ the recovering wording is never used', file: RF, tests: RATE,
    find: '    const detail = c.recovering === true',
    to: '    const detail = false /* MUTANT */',
    why: 'As C28-iii, at the card builder.' },
  { id: 'C28-v. ★★ a muted collapse logs WARN', file: RF, tests: RATE,
    find: '  return muteReason == null',
    to: '  return true /* MUTANT */',
    why: 'A level-40 line for hardware that cannot supply the house.' },
  { id: 'C28-vi. ★ (source pin) the tick logs every collapse at warn', file: IX, tests: RATE,
    find: "if (line.level === 'warn') app.log.warn(line.text); else app.log.info(line.text);",
    to: 'app.log.warn(line.text); /* MUTANT */',
    why: 'The INFO verdict is computed and ignored.' },
  // ── C29: blind hold and shadow latch lines ──
  { id: 'C29-i. ★★ the hold end claims the remediation restored telemetry', file: BL, tests: BLIND,
    find: '      log(blindRestoredLine(state.remediatedAtMs, nowMs));',
    to: "      log('telemetry-blind: telemetry RESTORED by the remediation — the alarm never sounded'); /* MUTANT */",
    why: 'A cause read from timing alone (a released latch with no telemetry back reads the same).' },
  { id: 'C29-ii. ★★ the latch setting logs at info', file: SS, tests: BLIND,
    find: '      (latched ? (this.warnLogger ?? this.logger) : this.logger)(',
    to: '      this.logger( /* MUTANT */',
    why: 'The root condition (grid presence UNKNOWN) is the one line a level-40 scan misses.' },
  { id: 'C29-iii. ★ (source pin) the poll loop does not wire its warn sink', file: SS, tests: BLIND,
    find: '  store.setWarnLogger(warn); // v1.187.10 — the stale-shadow latch setting',
    to: '  /* MUTANT */',
    why: 'In production the latch line falls back to info.' },
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
const testsPass = (tests) => passes('node', ['--import', 'tsx', '--test', ...tests]);
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
const baselines = [...new Set(MUTANTS.map((m) => JSON.stringify(m.tests)))].map((s) => JSON.parse(s));
for (const t of baselines) {
  if (!testsPass(t)) {
    console.error(`\nABORT: ${t.join(' ')} fails on the UNMUTATED tree. Fix the baseline first.`);
    process.exit(2);
  }
}

let fullBaselineChecked = false;
let killed = 0;
const survivors = [];
console.log(`mutate-v1187-10-g3: ${MUTANTS.length} mutants\n`);

try {
  for (const m of MUTANTS) {
    const original = originals.get(m.file);
    const mutated = original.replace(m.find, m.to);
    writeFileSync(m.file, mutated);
    let died = !testsPass(m.tests);
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
