#!/usr/bin/env node
/**
 * mutate-pool-out.mjs — committed harness for v1.208.0: a Core out of the panel's backup pool.
 *
 * On 2026-11-14 a Core left the panel's pool (92.16 → 61.44 kWh) and nothing alerted. The tracker (server/src/poolOut.ts)
 * raises on the CAPACITY alone, lets the pool percent and each slot's share of the load name the slot and shorten the dwell,
 * and quotes the panel's flags without acting on them; the reader (server/src/ecoflow/poolDiag.ts) takes every field with a
 * missing key as null and no meaning attached to a code. Each mutant below removes or moves one of those rules.
 *
 * (T) THRESHOLDS AND DWELLS, each moved both ways: the capacity tolerance; the percent's 0.75 and 1.5; the power's 0.2, 150 W,
 *     300 W and 50 W; 6 observations over 10 minutes; 15 over 15; the 15-minute gap; 3 healthy readings over 2 minutes; the ring
 *     of 30; 3 loss steps of 2 readings inside 60 minutes; 5 polls before a blind conversion; the 30-minute blind warning; the
 *     clear at 30 minutes and 18 readings and its 10-minute, 6-reading shortening; the reference's 10 minutes and 6 readings;
 *     3 grid readings no older than 5 minutes; the sensor's 15 minutes; the notes' 30 minutes; the end record's 24 hours; the
 *     percent step's 3 points and 5 minutes.
 * (O) WHICH BODIES ARE OBSERVATIONS: offline, replayed, latched, incoherent, a roster slot with no isConnect; the ring kept
 *     while latched; the blind conversions and what each needs; the blind warning said once, and only while the panel is fresh.
 * (S) THE SIGNALS: the capacity's own naming and its limits; the percent's count from the capacity, its single match and its
 *     weighting; the power's charging and reserve gates; FLAG never raising, shortening, naming or blocking; the percent and the
 *     power never raising alone; NOCAP and the held contradiction never counted.
 * (D) THE STREAK AND THE EPISODE: healthy readings that reset, and what breaks their run; the flap rule's "consecutive"; the
 *     naming conflict; the latched set; the clear on capacity evidence only; the reference never taken during an episode.
 * (V) SEVERITY: under half the reference, on the confirmed capacity; the grid known absent on both sources; unknown holds;
 *     the return to warning on both sources.
 * (F) THE STATE FILE: the episode, the streak, the ring, the reference and the grid flag restored; the in-process flags never.
 * (W) THE WORDS: a code as its number alone; an entry in wire order, spaced; the lead regenerated while the clear is pending;
 *     the grid sentence second on a grid critical; "no error code" only of what was read; the unquoted keys kept out.
 * (P) THE DELIVERY POLICY: its one constant and its two outputs.
 * (X) THE WIRING: the store's fold of each REST body (only REST, the body's own time, the latch after the poll, the grid
 *     not known unless a source says otherwise); the state file (loaded, not believed from a read-only folder, saved on a
 *     change and at most once a minute otherwise); the change log on new content only; the captures and their pruning; the
 *     alert (not gated on the projection, its panel as its source, after every reserve pair, the quiet-hours flag from the
 *     delivery function, the house panel's id); the monitor (the context field, the family listing, the flag's one reader,
 *     the return notice for this id only, the boot orphan hold, the grid source and its hand-over); the recorder's block;
 *     the Home Assistant field and entity; where the state file and the captures go when the caller names no path (inside
 *     the add-on beside the database, outside it nowhere: test/poolOutStatePath.test.ts builds the store as production
 *     does); the first pass after a restart (a restored alarm is taken as announced only on a delivery record); the
 *     reader's output kept off the projection.
 * (R) THE RECORD: a flag not sent is never recorded as off; the capture is an allowlist with its five dropped names, the
 *     identifier shape and the 64 KiB cap; the relay counters carried, flushed at a tracker event; a code standing at the
 *     first reading said at once; the served and the raw capacity apart; the count only on a judged capacity; the plant's
 *     sensor state never OFF on an unread panel.
 *
 * THE FIX ROUND OF THE THREE REVIEWS (each a rule a review showed unheld, or one its fix added):
 * (L) WHAT A RAISE LATCHES: the count, the capacity and the names each on a dwell of their own readings, never the one
 *     reading that completes the dwell; a larger count's own tally and its gap; a smaller count taking the streak over;
 *     the pending name carried across the raise; a pending decrease, ended by one reading at the latched count.
 * (B) BLINDNESS AND THE REFERENCE: a reading whose capacity cannot be judged runs the blind clock and is said; a
 *     reference that leaves a slot out says so, and earns no clean dwell for the boot sweep; a streak past its gap holds
 *     no adoption back; the blind clock across a gap in the bodies.
 * (K) THE STORE: the alarm's id and name latched at the raise, saved, restored, let go at the end, never shared; the
 *     load contained and an unread file kept; which captures go; a failed save removes the file; the return notice only
 *     with no alarm standing and only for an end after the push; a panel listed offline.
 * (M) THE MONITOR AND THE VOICE: a failed push tried again, no push debounce, the return notice in the boot sweep; this
 *     alarm yields the spoken message.
 * (Y) WORDS, THE SENSOR, THE READER, THE RECORD: the six sentences made true; the sensor on a capacity that reads short;
 *     64 kept entries and their count; the one-line change log; an identifier inside a list; the three lines of index.ts.
 *
 *   node scripts/mutate-pool-out.mjs [--only <id prefix>]
 *
 * ★ Every id starts PO- (no other harness uses it; mutate-pool-membership.mjs is the v1.92.0 roster harness and is not this
 *   one). Anchor-asserted (each anchor matches exactly once); every mutant must TYPECHECK (one that does not is reported
 *   INVALID and fails the run); each mutant names the test files that must kill it, and only those run for it. Run with
 *   MUTATE_CONCURRENCY=4, on a GREEN tree. test/poolOutMonitor.test.ts runs the real alert monitor (its mutants take a
 *   few seconds each).
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PO = resolve(REPO, 'server/src/poolOut.ts');
const PD = resolve(REPO, 'server/src/ecoflow/poolDiag.ts');
const SN = resolve(REPO, 'server/src/snapshot.ts');
const AL = resolve(REPO, 'server/src/alerts.ts');
const AM = resolve(REPO, 'server/src/alertMonitor.ts');
const RC = resolve(REPO, 'server/src/recorder.ts');
const MQ = resolve(REPO, 'server/src/mqttDiscovery.ts');
const PR = resolve(REPO, 'server/src/poolOutRecord.ts');
const MB = resolve(REPO, 'server/src/shp2Membership.ts');
const TS = resolve(REPO, 'server/src/ttsService.ts');
const IX = resolve(REPO, 'server/src/index.ts');

const T_RULES = 'test/poolOutRules.test.ts';
const T_NOFALSE = 'test/poolOutNoFalseAlarm.test.ts';
const T_REPLAY = 'test/poolOutReplay.test.ts';
const T_TEXT = 'test/poolOutText.test.ts';
const T_DIAG = 'test/poolDiag.test.ts';
const T_DELIVERY = 'test/poolOutDelivery.test.ts';
const T_STORE = 'test/poolOutStore.test.ts';
const T_MONITOR = 'test/poolOutMonitor.test.ts';
const T_ALERT = 'test/poolOutAlert.test.ts';
const T_RECORD = 'test/poolOutRecord.test.ts';
const T_RECORDER = 'test/poolOutRecorder.test.ts';
const T_HA = 'test/poolOutHa.test.ts';
const T_PATH = 'test/poolOutStatePath.test.ts';
const T_BOOT = 'test/poolOutMonitorBoot.test.ts';
const RULES = [T_RULES, T_NOFALSE, T_REPLAY];
const WORDS = [T_TEXT, T_REPLAY];

const C_CAP = 'export const POOL_OUT_CAP_TOLERANCE_WH = 1024;';
const C_PCT_MATCH = 'export const POOL_OUT_PCT_MATCH_PTS = 0.75;';
const C_PCT_APART = 'export const POOL_OUT_PCT_APART_PTS = 1.5;';
const C_SHARE = 'export const POOL_OUT_FLOW_SHARE_MIN = 0.2;';
const C_EXPECTED = 'export const POOL_OUT_FLOW_MIN_EXPECTED_W = 150;';
const C_TOTAL = 'export const POOL_OUT_FLOW_MIN_TOTAL_W = 300;';
const C_CHARGING = 'export const POOL_OUT_FLOW_CHARGING_W = 50;';
const C_STRONG_OBS = 'export const POOL_OUT_STRONG_MIN_OBS = 6;';
const C_STRONG_MS = 'export const POOL_OUT_STRONG_MIN_MS = 10 * 60_000;';
const C_SLOW_OBS = 'export const POOL_OUT_SLOW_MIN_OBS = 15;';
const C_SLOW_MS = 'export const POOL_OUT_SLOW_MIN_MS = 15 * 60_000;';
const C_GAP = 'export const POOL_OUT_STREAK_MAX_GAP_MS = 15 * 60_000;';
const C_IN_OBS = 'export const POOL_OUT_IN_RESET_OBS = 3;';
const C_IN_MS = 'export const POOL_OUT_IN_RESET_MS = 2 * 60_000;';
const C_RING = 'export const POOL_OUT_WITNESS_RING = 30;';
const C_FLAP_STEPS = 'export const POOL_OUT_FLAP_STEPS = 3;';
const C_FLAP_OBS = 'export const POOL_OUT_FLAP_STEP_MIN_OBS = 2;';
const C_FLAP_MS = 'export const POOL_OUT_FLAP_WINDOW_MS = 60 * 60_000;';
const C_CONVERT = 'export const POOL_OUT_SKIP_CONVERT_POLLS = 5;';
const C_BLIND = 'export const POOL_OUT_BLIND_WARN_MS = 30 * 60_000;';
const C_CLEAR_OBS = 'export const POOL_OUT_CLEAR_MIN_OBS = 18;';
const C_CLEAR_MS = 'export const POOL_OUT_CLEAR_MIN_MS = 30 * 60_000;';
const C_FAST_OBS = 'export const POOL_OUT_FAST_CLEAR_MIN_OBS = 6;';
const C_FAST_MS = 'export const POOL_OUT_FAST_CLEAR_MIN_MS = 10 * 60_000;';
const C_ADOPT_OBS = 'export const POOL_OUT_ADOPT_MIN_OBS = 6;';
const C_ADOPT_MS = 'export const POOL_OUT_ADOPT_MIN_MS = 10 * 60_000;';
const C_GRID_N = 'export const POOL_OUT_GRID_READINGS = 3;';
const C_GRID_AGE = 'export const POOL_OUT_GRID_MAX_AGE_MS = 5 * 60_000;';
const C_SENSOR = 'export const POOL_OUT_SENSOR_FRESH_MS = 15 * 60_000;';
const C_STALE = 'export const POOL_OUT_STALE_NOTE_MS = 5 * 60_000;';
const C_NOTE = 'export const POOL_OUT_NOTE_EVERY_MS = 30 * 60_000;';
const C_KEEP = 'export const POOL_OUT_END_KEEP_MS = 24 * 60 * 60_000;';
const C_STEP_PTS = 'export const POOL_OUT_STEP_MIN_PTS = 3;';
const C_STEP_GAP = 'export const POOL_OUT_STEP_MAX_GAP_MS = 5 * 60_000;';

const APART = '  if (apart > POOL_OUT_PCT_APART_PTS) {';
const CLASS_STRONG = "    if (pct.v === 'fault' || flow.v === 'fault') return 'STRONG';";
const CLASS_IN = "  if (cap.v === 'healthy') return 'IN';";
const SIG_CLS = '  const cls = classify(cap, pct, flow);';
const OWN = '  const own = [...new Set([...notConnected, ...notListed, ...lostCap])].sort((a, b) => a - b);';
const CHARGING = "  if (slots.some((r) => (r.chWatt as number) > POOL_OUT_FLOW_CHARGING_W || (r.inputW as number) > POOL_OUT_FLOW_CHARGING_W)) return unknown('charging');";
const GRID_ABSENT = "  if (obs.grid.present === false && !obs.grid.presenceUnknown && sta !== 1) return 'absent';";
const HALF = "  if (ep.countedWh < ep.baselineWh / 2) return 'critical';";
const FAST = '      const fast = evidenced && runMet(run, POOL_OUT_FAST_CLEAR_MIN_OBS, POOL_OUT_FAST_CLEAR_MIN_MS);';
const SLOW = '      const slow = runMet(run, POOL_OUT_CLEAR_MIN_OBS, POOL_OUT_CLEAR_MIN_MS);';
const SPEAK = "    speak: severity === 'critical' && !inQuietHours,";
const HEX = "  return bytes.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');";
const GRID_BLOCK = "    if (s.grid.every((r) => r.g === 'absent' && obs.atMs - r.atMs >= 0 && obs.atMs - r.atMs <= POOL_OUT_GRID_MAX_AGE_MS)) {";
const CONVERT_ZERO = "    if (reason === 'zero-capacity' && s.baseline != null) { opts = { allOut: true }; converted = 'all-out'; }";
const FOLD_CALL = "    if (source === 'rest' && cur.projection?.kind === 'shp2') this.foldPoolOut(sn, cur, raw, nowQ, witness, latched);";
const SAVE_WHEN = '    if (step.changed || sigChanged || ((standing || this.poolOutDirty) && (sinceWrite >= POOL_OUT_PERSIST_EVERY_MS || sinceWrite < 0))) this.writePoolOut(atMs);';
const ORPHAN_HELD = '  return panelSn == null || !released(panelSn);';
const PLANT_OFF = "  return panels.length > 0 && panels.every((p) => p === 'off') ? 'OFF' : null;";
const CAPTURE_TOP = '  return top && value !== null && primitive(value);';
const STATE_PATH = "    this.poolOutPath = opts.poolOutPath !== undefined ? opts.poolOutPath : config.isAddon ? config.dataFile('pool-out.json') : null;";
const EVENTS_DIR = "    this.poolEventsDir = opts.poolEventsDir !== undefined ? opts.poolEventsDir : config.isAddon ? resolve(config.dataRoot, 'pool-events') : null;";
const BOOT_SEED = '  if (p.alert.id === POOL_OUT_ALERT_ID || p.alert.id.startsWith(`${POOL_OUT_ALERT_ID}-`)) return p.alreadyNotified;';

const MUTANTS = [
  /* ── T: thresholds and dwells, each moved both ways ── */
  {
    id: 'PO-T-i. ★★★ CAP tolerance 1,025 Wh',
    file: PO, tests: RULES,
    find: C_CAP,
    to: 'export const POOL_OUT_CAP_TOLERANCE_WH = 1025; /* MUTANT */',
    why: 'A capacity 1,025 Wh off reads as equal, and as a whole slot.',
  },
  {
    id: 'PO-T-ii. ★★★ CAP tolerance 1,023 Wh',
    file: PO, tests: RULES,
    find: C_CAP,
    to: 'export const POOL_OUT_CAP_TOLERANCE_WH = 1023; /* MUTANT */',
    why: 'A capacity 1,024 Wh off no longer reads as equal.',
  },
  {
    id: 'PO-T-iii. ★★★ PCT match 0.76',
    file: PO, tests: RULES,
    find: C_PCT_MATCH,
    to: 'export const POOL_OUT_PCT_MATCH_PTS = 0.76; /* MUTANT */',
    why: 'A pool 0.76 from a mean matches it.',
  },
  {
    id: 'PO-T-iv. ★★★ PCT match 0.74',
    file: PO, tests: RULES,
    find: C_PCT_MATCH,
    to: 'export const POOL_OUT_PCT_MATCH_PTS = 0.74; /* MUTANT */',
    why: 'A pool 0.75 from a mean no longer matches it.',
  },
  {
    id: 'PO-T-v. ★★★ PCT apart 1.6',
    file: PO, tests: RULES,
    find: C_PCT_APART,
    to: 'export const POOL_OUT_PCT_APART_PTS = 1.6; /* MUTANT */',
    why: 'A pool 1.51 from the mean of all is not apart: the percent names nobody.',
  },
  {
    id: 'PO-T-vi. ★★★ PCT apart at exactly 1.5',
    file: PO, tests: RULES,
    find: APART,
    to: '  if (apart >= POOL_OUT_PCT_APART_PTS) { /* MUTANT */',
    why: 'Exactly 1.5 points is a fault: the normal maximum of 0.67 has that much less margin.',
  },
  {
    id: 'PO-T-vii. ★★★ FLOW share 0.21',
    file: PO, tests: RULES,
    find: C_SHARE,
    to: 'export const POOL_OUT_FLOW_SHARE_MIN = 0.21; /* MUTANT */',
    why: 'A slot carrying exactly a fifth of its share carries none.',
  },
  {
    id: 'PO-T-viii. ★★★ FLOW share 0.19',
    file: PO, tests: RULES,
    find: C_SHARE,
    to: 'export const POOL_OUT_FLOW_SHARE_MIN = 0.19; /* MUTANT */',
    why: 'A slot under a fifth of its share is healthy.',
  },
  {
    id: 'PO-T-ix. ★★★ FLOW share 0.5 (the backtest\'s false positives)',
    file: PO, tests: [T_NOFALSE],
    find: C_SHARE,
    to: 'export const POOL_OUT_FLOW_SHARE_MIN = 0.5; /* MUTANT */',
    why: 'The reading of 2026-11-09 23:00 (the reserve moved inside it) reads as a slot carrying no share.',
  },
  {
    id: 'PO-T-x. ★★★ FLOW expected share from 151 W',
    file: PO, tests: RULES,
    find: C_EXPECTED,
    to: 'export const POOL_OUT_FLOW_MIN_EXPECTED_W = 151; /* MUTANT */',
    why: 'A slot expected to carry exactly 150 W is not judged.',
  },
  {
    id: 'PO-T-xi. ★★★ FLOW expected share from 120 W (a slot near the reserve)',
    file: PO, tests: RULES,
    find: C_EXPECTED,
    to: 'export const POOL_OUT_FLOW_MIN_EXPECTED_W = 120; /* MUTANT */',
    why: 'A slot expected to carry 149 W, or the 121 W of 2026-10-30 01:25, is judged.',
  },
  {
    id: 'PO-T-xii. ★★★ FLOW total from 301 W',
    file: PO, tests: RULES,
    find: C_TOTAL,
    to: 'export const POOL_OUT_FLOW_MIN_TOTAL_W = 301; /* MUTANT */',
    why: 'A pool discharging exactly 300 W is not judged.',
  },
  {
    id: 'PO-T-xiii. ★★★ FLOW total from 299 W',
    file: PO, tests: RULES,
    find: C_TOTAL,
    to: 'export const POOL_OUT_FLOW_MIN_TOTAL_W = 299; /* MUTANT */',
    why: 'A pool discharging 299 W is judged.',
  },
  {
    id: 'PO-T-xiv. ★★★ charging from 50 W',
    file: PO, tests: RULES,
    find: C_CHARGING,
    to: 'export const POOL_OUT_FLOW_CHARGING_W = 49; /* MUTANT */',
    why: 'A slot taking 50 W counts as charging: nothing is judged.',
  },
  {
    id: 'PO-T-xv. ★★★ charging above 51 W',
    file: PO, tests: RULES,
    find: C_CHARGING,
    to: 'export const POOL_OUT_FLOW_CHARGING_W = 51; /* MUTANT */',
    why: 'A slot taking 51 W is not charging: the others are judged while it charges.',
  },
  {
    id: 'PO-T-xvi. ★★★ STRONG dwell 5 observations',
    file: PO, tests: RULES,
    find: C_STRONG_OBS,
    to: 'export const POOL_OUT_STRONG_MIN_OBS = 5; /* MUTANT */',
    why: 'Five readings raise.',
  },
  {
    id: 'PO-T-xvii. ★★★ STRONG dwell 7 observations',
    file: PO, tests: RULES,
    find: C_STRONG_OBS,
    to: 'export const POOL_OUT_STRONG_MIN_OBS = 7; /* MUTANT */',
    why: 'Six readings over ten minutes do not raise.',
  },
  {
    id: 'PO-T-xviii. ★★★ STRONG dwell 9 minutes',
    file: PO, tests: RULES,
    find: C_STRONG_MS,
    to: 'export const POOL_OUT_STRONG_MIN_MS = 9 * 60_000; /* MUTANT */',
    why: 'Six readings spanning 9:59 raise.',
  },
  {
    id: 'PO-T-xix. ★★★ STRONG dwell 11 minutes',
    file: PO, tests: RULES,
    find: C_STRONG_MS,
    to: 'export const POOL_OUT_STRONG_MIN_MS = 11 * 60_000; /* MUTANT */',
    why: 'The 2026-11-14 loss raises a minute later than 23:46.',
  },
  {
    id: 'PO-T-xx. ★★★ capacity-alone dwell 9 observations (the design before the capacity backtest)',
    file: PO, tests: RULES,
    find: C_SLOW_OBS,
    to: 'export const POOL_OUT_SLOW_MIN_OBS = 9; /* MUTANT */',
    why: 'Fourteen capacity-only readings over twenty minutes raise.',
  },
  {
    id: 'PO-T-xxi. ★★★ capacity-alone dwell 16 observations',
    file: PO, tests: RULES,
    find: C_SLOW_OBS,
    to: 'export const POOL_OUT_SLOW_MIN_OBS = 16; /* MUTANT */',
    why: 'Fifteen readings over fifteen minutes do not raise.',
  },
  {
    id: 'PO-T-xxii. ★★★ capacity-alone dwell 14 minutes',
    file: PO, tests: RULES,
    find: C_SLOW_MS,
    to: 'export const POOL_OUT_SLOW_MIN_MS = 14 * 60_000; /* MUTANT */',
    why: 'A 14-minute capacity dip (hardware work) raises.',
  },
  {
    id: 'PO-T-xxiii. ★★★ capacity-alone dwell 16 minutes',
    file: PO, tests: RULES,
    find: C_SLOW_MS,
    to: 'export const POOL_OUT_SLOW_MIN_MS = 16 * 60_000; /* MUTANT */',
    why: 'Fifteen minutes on the capacity alone do not raise.',
  },
  {
    id: 'PO-T-xxiv. ★★★ streak gap 16 minutes',
    file: PO, tests: RULES,
    find: C_GAP,
    to: 'export const POOL_OUT_STREAK_MAX_GAP_MS = 16 * 60_000; /* MUTANT */',
    why: 'A streak is carried across 15:01.',
  },
  {
    id: 'PO-T-xxv. ★★★ streak gap 14 minutes',
    file: PO, tests: RULES,
    find: C_GAP,
    to: 'export const POOL_OUT_STREAK_MAX_GAP_MS = 14 * 60_000; /* MUTANT */',
    why: 'A streak is dropped at 15:00.',
  },
  {
    id: 'PO-T-xxvi. ★★★ two healthy readings reset a streak',
    file: PO, tests: RULES,
    find: C_IN_OBS,
    to: 'export const POOL_OUT_IN_RESET_OBS = 2; /* MUTANT */',
    why: 'Two stale healthy bodies two minutes apart restart the dwell.',
  },
  {
    id: 'PO-T-xxvii. ★★★ one healthy reading resets a streak (the design before the review)',
    file: PO, tests: RULES,
    find: C_IN_OBS,
    to: 'export const POOL_OUT_IN_RESET_OBS = 1; /* MUTANT */',
    why: 'One stale healthy body restarts the dwell.',
  },
  {
    id: 'PO-T-xxviii. ★★★ four healthy readings to reset',
    file: PO, tests: RULES,
    find: C_IN_OBS,
    to: 'export const POOL_OUT_IN_RESET_OBS = 4; /* MUTANT */',
    why: 'Three healthy readings over two minutes leave the streak standing.',
  },
  {
    id: 'PO-T-xxix. ★★★ the reset run spans 1 minute',
    file: PO, tests: RULES,
    find: C_IN_MS,
    to: 'export const POOL_OUT_IN_RESET_MS = 1 * 60_000; /* MUTANT */',
    why: 'Three healthy bodies inside one minute reset a streak.',
  },
  {
    id: 'PO-T-xxx. ★★★ the reset run spans 3 minutes',
    file: PO, tests: RULES,
    find: C_IN_MS,
    to: 'export const POOL_OUT_IN_RESET_MS = 3 * 60_000; /* MUTANT */',
    why: 'Three healthy readings over two minutes leave the streak standing.',
  },
  {
    id: 'PO-T-xxxi. ★★★ the ring holds 29',
    file: PO, tests: RULES,
    find: C_RING,
    to: 'export const POOL_OUT_WITNESS_RING = 29; /* MUTANT */',
    why: 'The 30th newest body is forgotten.',
  },
  {
    id: 'PO-T-xxxii. ★★★ the ring holds 31',
    file: PO, tests: RULES,
    find: C_RING,
    to: 'export const POOL_OUT_WITNESS_RING = 31; /* MUTANT */',
    why: 'The stated size is not the size.',
  },
  {
    id: 'PO-T-xxxiii. ★★★ flap: two steps raise',
    file: PO, tests: RULES,
    find: C_FLAP_STEPS,
    to: 'export const POOL_OUT_FLAP_STEPS = 2; /* MUTANT */',
    why: 'The second loss step raises.',
  },
  {
    id: 'PO-T-xxxiv. ★★★ flap: four steps to raise',
    file: PO, tests: RULES,
    find: C_FLAP_STEPS,
    to: 'export const POOL_OUT_FLAP_STEPS = 4; /* MUTANT */',
    why: 'The third loss step does not raise.',
  },
  {
    id: 'PO-T-xxxv. ★★★ flap: a step of one reading',
    file: PO, tests: RULES,
    find: C_FLAP_OBS,
    to: 'export const POOL_OUT_FLAP_STEP_MIN_OBS = 1; /* MUTANT */',
    why: 'A single fault reading is a confirmed loss step.',
  },
  {
    id: 'PO-T-xxxvi. ★★★ flap: a step of three readings',
    file: PO, tests: RULES,
    find: C_FLAP_OBS,
    to: 'export const POOL_OUT_FLAP_STEP_MIN_OBS = 3; /* MUTANT */',
    why: 'Two consecutive fault readings are not a step.',
  },
  {
    id: 'PO-T-xxxvii. ★★★ flap window 61 minutes',
    file: PO, tests: RULES,
    find: C_FLAP_MS,
    to: 'export const POOL_OUT_FLAP_WINDOW_MS = 61 * 60_000; /* MUTANT */',
    why: 'Three steps spanning 60:01 raise.',
  },
  {
    id: 'PO-T-xxxviii. ★★★ flap window 59 minutes',
    file: PO, tests: RULES,
    find: C_FLAP_MS,
    to: 'export const POOL_OUT_FLAP_WINDOW_MS = 59 * 60_000; /* MUTANT */',
    why: 'Three steps spanning 60:00 do not raise.',
  },
  {
    id: 'PO-T-xxxix. ★★★ blind conversion after 4 polls',
    file: PO, tests: RULES,
    find: C_CONVERT,
    to: 'export const POOL_OUT_SKIP_CONVERT_POLLS = 4; /* MUTANT */',
    why: 'The fourth unusable poll is already a vote.',
  },
  {
    id: 'PO-T-xl. ★★★ blind conversion after 6 polls',
    file: PO, tests: RULES,
    find: C_CONVERT,
    to: 'export const POOL_OUT_SKIP_CONVERT_POLLS = 6; /* MUTANT */',
    why: 'The fifth unusable poll is still skipped.',
  },
  {
    id: 'PO-T-xli. ★★★ blind warning at 29 minutes',
    file: PO, tests: RULES,
    find: C_BLIND,
    to: 'export const POOL_OUT_BLIND_WARN_MS = 29 * 60_000; /* MUTANT */',
    why: 'The warning comes a minute early.',
  },
  {
    id: 'PO-T-xlii. ★★★ blind warning at 31 minutes',
    file: PO, tests: RULES,
    find: C_BLIND,
    to: 'export const POOL_OUT_BLIND_WARN_MS = 31 * 60_000; /* MUTANT */',
    why: 'Thirty blind minutes pass without a word.',
  },
  {
    id: 'PO-T-xliii. ★★★ clear on 17 observations',
    file: PO, tests: RULES,
    find: C_CLEAR_OBS,
    to: 'export const POOL_OUT_CLEAR_MIN_OBS = 17; /* MUTANT */',
    why: 'Seventeen capacity-only readings clear.',
  },
  {
    id: 'PO-T-xliv. ★★★ clear on 19 observations',
    file: PO, tests: RULES,
    find: C_CLEAR_OBS,
    to: 'export const POOL_OUT_CLEAR_MIN_OBS = 19; /* MUTANT */',
    why: 'Eighteen readings over thirty minutes do not clear.',
  },
  {
    id: 'PO-T-xlv. ★★★ clear after 29 minutes',
    file: PO, tests: RULES,
    find: C_CLEAR_MS,
    to: 'export const POOL_OUT_CLEAR_MIN_MS = 29 * 60_000; /* MUTANT */',
    why: 'A capacity held 29:59 clears.',
  },
  {
    id: 'PO-T-xlvi. ★★★ clear after 31 minutes',
    file: PO, tests: RULES,
    find: C_CLEAR_MS,
    to: 'export const POOL_OUT_CLEAR_MIN_MS = 31 * 60_000; /* MUTANT */',
    why: 'A capacity held thirty minutes does not clear.',
  },
  {
    id: 'PO-T-xlvii. ★★★ fast clear on 5 observations',
    file: PO, tests: RULES,
    find: C_FAST_OBS,
    to: 'export const POOL_OUT_FAST_CLEAR_MIN_OBS = 5; /* MUTANT */',
    why: 'Five readings clear.',
  },
  {
    id: 'PO-T-xlviii. ★★★ fast clear on 7 observations',
    file: PO, tests: RULES,
    find: C_FAST_OBS,
    to: 'export const POOL_OUT_FAST_CLEAR_MIN_OBS = 7; /* MUTANT */',
    why: 'Six evidenced readings over ten minutes do not clear.',
  },
  {
    id: 'PO-T-xlix. ★★★ fast clear after 9 minutes',
    file: PO, tests: RULES,
    find: C_FAST_MS,
    to: 'export const POOL_OUT_FAST_CLEAR_MIN_MS = 9 * 60_000; /* MUTANT */',
    why: 'An evidenced return clears at 9:59.',
  },
  {
    id: 'PO-T-l. ★★★ fast clear after 11 minutes',
    file: PO, tests: RULES,
    find: C_FAST_MS,
    to: 'export const POOL_OUT_FAST_CLEAR_MIN_MS = 11 * 60_000; /* MUTANT */',
    why: 'The 2026-11-16 return clears a minute later than 20:19.',
  },
  {
    id: 'PO-T-li. ★★★ reference on 5 observations',
    file: PO, tests: RULES,
    find: C_ADOPT_OBS,
    to: 'export const POOL_OUT_ADOPT_MIN_OBS = 5; /* MUTANT */',
    why: 'Five healthy readings make a reference.',
  },
  {
    id: 'PO-T-lii. ★★★ reference on 7 observations',
    file: PO, tests: RULES,
    find: C_ADOPT_OBS,
    to: 'export const POOL_OUT_ADOPT_MIN_OBS = 7; /* MUTANT */',
    why: 'Six healthy readings over ten minutes make none.',
  },
  {
    id: 'PO-T-liii. ★★★ reference after 9 minutes',
    file: PO, tests: RULES,
    find: C_ADOPT_MS,
    to: 'export const POOL_OUT_ADOPT_MIN_MS = 9 * 60_000; /* MUTANT */',
    why: 'A reference is taken at 9:59.',
  },
  {
    id: 'PO-T-liv. ★★★ reference after 11 minutes',
    file: PO, tests: RULES,
    find: C_ADOPT_MS,
    to: 'export const POOL_OUT_ADOPT_MIN_MS = 11 * 60_000; /* MUTANT */',
    why: 'Ten healthy minutes make no reference.',
  },
  {
    id: 'PO-T-lv. ★★★ critical by the grid on 2 readings',
    file: PO, tests: RULES,
    find: C_GRID_N,
    to: 'export const POOL_OUT_GRID_READINGS = 2; /* MUTANT */',
    why: 'Two readings with no grid make a critical, and two with it end one.',
  },
  {
    id: 'PO-T-lvi. ★★★ critical by the grid on 4 readings',
    file: PO, tests: RULES,
    find: C_GRID_N,
    to: 'export const POOL_OUT_GRID_READINGS = 4; /* MUTANT */',
    why: 'Three readings with no grid are not enough.',
  },
  {
    id: 'PO-T-lvii. ★★★ grid readings up to 6 minutes old',
    file: PO, tests: RULES,
    find: C_GRID_AGE,
    to: 'export const POOL_OUT_GRID_MAX_AGE_MS = 6 * 60_000; /* MUTANT */',
    why: 'A reading 5:01 old counts toward a critical.',
  },
  {
    id: 'PO-T-lviii. ★★★ grid readings up to 4 minutes old',
    file: PO, tests: RULES,
    find: C_GRID_AGE,
    to: 'export const POOL_OUT_GRID_MAX_AGE_MS = 4 * 60_000; /* MUTANT */',
    why: 'A reading 5:00 old does not count.',
  },
  {
    id: 'PO-T-lix. ★★ the sensor reads OFF for 16 minutes',
    file: PO, tests: [T_RULES],
    find: C_SENSOR,
    to: 'export const POOL_OUT_SENSOR_FRESH_MS = 16 * 60_000; /* MUTANT */',
    why: 'OFF on a verdict 15:01 old.',
  },
  {
    id: 'PO-T-lx. ★★ the sensor reads OFF for 14 minutes',
    file: PO, tests: [T_RULES],
    find: C_SENSOR,
    to: 'export const POOL_OUT_SENSOR_FRESH_MS = 14 * 60_000; /* MUTANT */',
    why: 'Unknown on a verdict 15:00 old.',
  },
  {
    id: 'PO-T-lxi. ★★ "no new reading" after 6 minutes',
    file: PO, tests: WORDS,
    find: C_STALE,
    to: 'export const POOL_OUT_STALE_NOTE_MS = 6 * 60_000; /* MUTANT */',
    why: 'A reading 5:01 old is described as now with no note.',
  },
  {
    id: 'PO-T-lxii. ★★ "no new reading" after 4 minutes',
    file: PO, tests: WORDS,
    find: C_STALE,
    to: 'export const POOL_OUT_STALE_NOTE_MS = 4 * 60_000; /* MUTANT */',
    why: 'The note appears on a reading 5:00 old.',
  },
  {
    id: 'PO-T-lxiii. ★★ notes every 10 minutes',
    file: PO, tests: RULES,
    find: C_NOTE,
    to: 'export const POOL_OUT_NOTE_EVERY_MS = 10 * 60_000; /* MUTANT */',
    why: 'A held contradiction is logged six times an hour.',
  },
  {
    id: 'PO-T-lxiv. ★★ notes every 2 hours',
    file: PO, tests: RULES,
    find: C_NOTE,
    to: 'export const POOL_OUT_NOTE_EVERY_MS = 120 * 60_000; /* MUTANT */',
    why: 'An hour of NOCAP readings leaves one line.',
  },
  {
    id: 'PO-T-lxv. ★★ end records kept 25 hours',
    file: PO, tests: [T_RULES],
    find: C_KEEP,
    to: 'export const POOL_OUT_END_KEEP_MS = 25 * 60 * 60_000; /* MUTANT */',
    why: 'A return notice older than a day is still served.',
  },
  {
    id: 'PO-T-lxvi. ★★ end records kept 23 hours',
    file: PO, tests: [T_RULES],
    find: C_KEEP,
    to: 'export const POOL_OUT_END_KEEP_MS = 23 * 60 * 60_000; /* MUTANT */',
    why: 'A return notice is dropped before a day is out.',
  },
  {
    id: 'PO-T-lxvii. ★★★ a 2.5-point step is called membership',
    file: PO, tests: WORDS,
    find: C_STEP_PTS,
    to: 'export const POOL_OUT_STEP_MIN_PTS = 2.5; /* MUTANT */',
    why: 'A step that five minutes of load can make is called "not charging".',
  },
  {
    id: 'PO-T-lxviii. ★★★ a 3-point step is not called membership',
    file: PO, tests: WORDS,
    find: C_STEP_PTS,
    to: 'export const POOL_OUT_STEP_MIN_PTS = 3.5; /* MUTANT */',
    why: 'The sentence the return notice exists for is dropped at 3 points.',
  },
  {
    id: 'PO-T-lxix. ★★★ a step across 6 minutes is called membership',
    file: PO, tests: WORDS,
    find: C_STEP_GAP,
    to: 'export const POOL_OUT_STEP_MAX_GAP_MS = 6 * 60_000; /* MUTANT */',
    why: 'A difference across a gap, which may be energy, is called "not charging".',
  },
  {
    id: 'PO-T-lxx. ★★★ a step across 5 minutes is not called membership',
    file: PO, tests: WORDS,
    find: C_STEP_GAP,
    to: 'export const POOL_OUT_STEP_MAX_GAP_MS = 4 * 60_000; /* MUTANT */',
    why: 'The 2026-11-16 return (47 % at 20:04, 64 % at 20:09) loses its sentence.',
  },

  /* ── O: which bodies are observations ── */
  {
    id: 'PO-O-i. ★★★ an offline panel\'s body is an observation',
    file: PO, tests: RULES,
    find: "  if (!obs.online) reason = 'offline';",
    to: "  if (!obs.online && obs.atMs < 0) reason = 'offline'; /* MUTANT */",
    why: 'A frozen last-known body counts toward a raise and a clear.',
  },
  {
    id: 'PO-O-ii. ★★★ a replayed body is an observation',
    file: PO, tests: RULES,
    find: "    else if (seen) reason = 'replayed';",
    to: "    else if (seen && obs.atMs < 0) reason = 'replayed'; /* MUTANT */",
    why: 'A cloud alternating two cached bodies raises, or clears.',
  },
  {
    id: 'PO-O-iii. ★★★ a latched shadow\'s body is an observation',
    file: PO, tests: RULES,
    find: "    if (obs.latched) reason = 'latched';",
    to: "    if (obs.latched && obs.atMs < 0) reason = 'latched'; /* MUTANT */",
    why: 'A stale shadow counts.',
  },
  {
    id: 'PO-O-iv. ★★★ an incoherent trio is an observation',
    file: PO, tests: RULES,
    find: "    else if (!obs.diag.pool.coherent) reason = 'incoherent';",
    to: "    else if (!obs.diag.pool.coherent && obs.atMs < 0) reason = 'incoherent'; /* MUTANT */",
    why: 'A new capacity with the old remainder starts a streak.',
  },
  {
    id: 'PO-O-v. ★★★ a roster slot with no isConnect is an observation at once',
    file: PO, tests: RULES,
    find: "    else if (missing.length > 0) reason = 'no-isconnect';",
    to: "    else if (missing.length > 0 && obs.atMs < 0) reason = 'no-isconnect'; /* MUTANT */",
    why: 'A partial body is read as a whole one.',
  },
  {
    id: 'PO-O-vi. ★★★ the reader calls every trio coherent',
    file: PD, tests: [T_DIAG, T_RULES, T_NOFALSE],
    find: '  const coherent = coherentBackupPool(pct, fullCapWh, remainWh).fullCapWh != null;',
    to: '  const coherent = true; /* MUTANT */ void coherentBackupPool;',
    why: 'O3 is gone at its source.',
  },
  {
    id: 'PO-O-vii. ★★★ a body seen while latched is forgotten',
    file: PO, tests: RULES,
    find: '    if (!seen) s.ring = [...s.ring, key].slice(-POOL_OUT_WITNESS_RING);',
    to: '    if (!seen && !obs.latched) s.ring = [...s.ring, key].slice(-POOL_OUT_WITNESS_RING); /* MUTANT */',
    why: 'The frozen body, served once more after the latch releases, counts as new.',
  },
  {
    id: 'PO-O-viii. ★★★ a zero capacity is converted without a reference',
    file: PO, tests: RULES,
    find: CONVERT_ZERO,
    to: "    if (reason === 'zero-capacity') { opts = { allOut: true }; converted = 'all-out'; } /* MUTANT */",
    why: 'A first start on a panel reporting zero raises "every Core out" against nothing.',
  },
  {
    id: 'PO-O-ix. ★★★ a zero capacity is never converted',
    file: PO, tests: RULES,
    find: CONVERT_ZERO,
    to: "    if (reason === 'zero-capacity' && s.baseline != null && obs.atMs < 0) { opts = { allOut: true }; converted = 'all-out'; } /* MUTANT */",
    why: 'Every Core out is skipped for ever, in silence.',
  },
  {
    id: 'PO-O-x. ★★★ an absent capacity is never converted',
    file: PO, tests: RULES,
    find: "    else if (reason === 'no-capacity') { opts = { capUnknown: true }; converted = 'cap-unknown'; }",
    to: "    else if (reason === 'no-capacity' && obs.atMs < 0) { opts = { capUnknown: true }; converted = 'cap-unknown'; } /* MUTANT */",
    why: 'A body without the capacity key is skipped for ever: percent and power are never judged.',
  },
  {
    id: 'PO-O-xi. ★★★ an absent isConnect is never converted',
    file: PO, tests: RULES,
    find: "    else if (reason === 'no-isconnect') { opts = { notListed: missing }; converted = 'not-listed'; }",
    to: "    else if (reason === 'no-isconnect' && obs.atMs < 0) { opts = { notListed: missing }; converted = 'not-listed'; } /* MUTANT */",
    why: 'A clean unplug that drops the slot\'s keys is skipped for ever.',
  },
  {
    id: 'PO-O-xii. ★★★ the poll count runs across reasons',
    file: PO, tests: RULES,
    find: '  s.skip = reason == null ? null : { reason, n: s.skip?.reason === reason ? s.skip.n + 1 : 1 };',
    to: '  s.skip = reason == null ? null : { reason, n: (s.skip?.n ?? 0) + 1 }; /* MUTANT */',
    why: 'Four polls of one reason and one of another convert the next.',
  },
  {
    id: 'PO-O-xiii. ★★★ the blind warning repeats',
    file: PO, tests: RULES,
    find: '      if (!s.blind.warned && obs.atMs - s.blind.sinceMs >= POOL_OUT_BLIND_WARN_MS) {',
    to: '      if (obs.atMs - s.blind.sinceMs >= POOL_OUT_BLIND_WARN_MS) { /* MUTANT */',
    why: 'One WARN line a minute for as long as the panel is unreadable.',
  },
  {
    id: 'PO-O-xiv. ★★★ the blind clock runs through a stale shadow',
    file: PO, tests: RULES,
    find: '    if (!fresh) s.blind = null;',
    to: '    if (!fresh && obs.atMs < 0) s.blind = null; /* MUTANT */',
    why: 'The warning blames a panel that is not fresh: the shadow has its own.',
  },
  {
    id: 'PO-O-xv. ★★★ a reading with no capacity verdict keeps the sensor OFF',
    file: PO, tests: RULES,
    find: "  if (cap.v !== 'unknown') s.lastCapMs = obs.atMs;",
    to: '  s.lastCapMs = obs.atMs; /* MUTANT */',
    why: 'Home Assistant shows "no Core out" while the capacity cannot be compared.',
  },

  /* ── S: the signals ── */
  {
    id: 'PO-S-i. ★★★ CAP healthy with a slot not listed as connected',
    file: PO, tests: RULES,
    find: "    if (notConnected.length === 0 && notListed.length === 0) return { v: 'healthy', reason: null, countedWh, expectedWh, ...none };",
    to: "    if (short < Infinity) return { v: 'healthy', reason: null, countedWh, expectedWh, ...none }; /* MUTANT */",
    why: 'A slot the panel stops listing, at an unchanged capacity, counts as "in" and can end a streak.',
  },
  {
    id: 'PO-S-ii. ★★★ a held listed-mismatch may read IN',
    file: PO, tests: RULES,
    find: "  if (cap.reason === 'listed-mismatch') return 'HOLD';",
    to: "  if (cap.reason === 'listed-mismatch' && pct.v !== 'consistent') return 'HOLD'; /* MUTANT */",
    why: 'A slot not listed as connected reads IN when the percent and power look normal.',
  },
  {
    id: 'PO-S-iii. ★★★ CAP matches every slot out on a coherent reading',
    file: PO, tests: RULES,
    find: '  for (let size = 1; size < roster.length && candidates.length === 0; size++) {',
    to: '  for (let size = 1; size <= roster.length && candidates.length === 0; size++) { /* MUTANT */',
    why: 'One coherent reading of a tiny capacity starts an "every Core out" streak without the zero-capacity rule\'s five polls.',
  },
  {
    id: 'PO-S-iv. ★★★ CAP ignores a slot\'s reference capacity',
    file: PO, tests: RULES,
    find: '    const ref = baseline?.slotCapWh[String(n)] ?? null;',
    to: '    const ref = null as number | null; void baseline; /* MUTANT */',
    why: 'A lost slot that zeroes its own capacity makes the capacity rule unknown: the loss is not seen.',
  },
  {
    id: 'PO-S-v. ★★★ CAP does not name a slot that is not connected',
    file: PO, tests: RULES,
    find: OWN,
    to: '  const own = [...new Set([...notListed, ...lostCap])].sort((a, b) => a - b); void notConnected; /* MUTANT */',
    why: 'A Core the panel itself lists as disconnected is "not identified".',
  },
  {
    id: 'PO-S-vi. ★★★ CAP does not name a slot that lost its capacity',
    file: PO, tests: RULES,
    find: OWN,
    to: '  const own = [...new Set([...notConnected, ...notListed])].sort((a, b) => a - b); void lostCap; /* MUTANT */',
    why: 'A slot reporting no capacity of its own is "not identified".',
  },
  {
    id: 'PO-S-vii. ★★★ CAP does not name a slot the panel no longer lists',
    file: PO, tests: RULES,
    find: OWN,
    to: '  const own = [...new Set([...notConnected, ...lostCap])].sort((a, b) => a - b); void notListed; /* MUTANT */',
    why: 'A slot whose keys vanished is "not identified".',
  },
  {
    id: 'PO-S-viii. ★★★ CAP names its flagged slots whatever the shortfall',
    file: PO, tests: RULES,
    find: '  const named = own.length > 0 && candidates.some((c) => sameSet(c, own)) ? own : null;',
    to: '  const named = own.length > 0 ? own : null; /* MUTANT */',
    why: 'Two flagged slots are named for a one-slot shortfall.',
  },
  {
    id: 'PO-S-ix. ★★★ CAP naming a slot is taken as a second signal',
    file: PO, tests: RULES,
    find: CLASS_STRONG,
    to: "    if (pct.v === 'fault' || flow.v === 'fault' || cap.named != null) return 'STRONG'; /* MUTANT */",
    why: 'One signal raises at the two-signal dwell.',
  },
  {
    id: 'PO-S-x. ★★★ PCT is not given the count',
    file: PO, tests: RULES,
    find: "  const pct = pctVerdict(diag, roster, baseline, cap.v === 'fault' ? cap.k : null, opts);",
    to: '  const pct = pctVerdict(diag, roster, baseline, null, opts); /* MUTANT */',
    why: 'The fast-charge reading of 11-16 07:50Z names slots 1 and 3.',
  },
  {
    id: 'PO-S-xi. ★★★ PCT names a set when two match',
    file: PO, tests: RULES,
    find: "      if (matches.length === 1) return { v: 'fault', set: matches[0], poolPct, meanAll, separable };",
    to: "      if (matches.length >= 1) return { v: 'fault', set: matches[0], poolPct, meanAll, separable }; /* MUTANT */",
    why: 'An ambiguous percent names the lower-numbered slot.',
  },
  {
    id: 'PO-S-xii. ★★★ PCT weighs the slots equally',
    file: PO, tests: RULES,
    find: '  const weights = caps.every((c) => c != null) ? (caps as number[]) : roster.map(() => 1);',
    to: '  const weights = roster.map(() => 1); void caps; /* MUTANT */',
    why: 'Once a pack leaves a Core the percent never matches a mean again.',
  },
  {
    id: 'PO-S-xiii. ★★★ FLOW judges while a slot charges on its channel',
    file: PO, tests: RULES,
    find: CHARGING,
    to: "  if (slots.some((r) => (r.inputW as number) > POOL_OUT_FLOW_CHARGING_W)) return unknown('charging'); /* MUTANT */",
    why: 'A slot charging from its own solar makes the others look idle.',
  },
  {
    id: 'PO-S-xiv. ★★★ FLOW judges while a slot takes AC input',
    file: PO, tests: RULES,
    find: CHARGING,
    to: "  if (slots.some((r) => (r.chWatt as number) > POOL_OUT_FLOW_CHARGING_W)) return unknown('charging'); /* MUTANT */",
    why: 'A grid-charging slot is judged as a discharging one.',
  },
  {
    id: 'PO-S-xv. ★★★ FLOW assumes a 15 % reserve when none is reported',
    file: PO, tests: RULES,
    find: '  const reserve = diag.reserveSoc;',
    to: '  const reserve = diag.reserveSoc ?? 15; /* MUTANT */',
    why: 'Shares are judged against a reserve nobody read.',
  },
  {
    id: 'PO-S-xvi. ★★★ a contradiction counts as SLOW',
    file: PO, tests: RULES,
    find: "    return flow.v === 'healthy' ? 'HOLD' : 'SLOW';",
    to: "    return 'SLOW'; /* MUTANT */",
    why: 'Capacity short while every slot carries its share raises after fifteen minutes.',
  },
  {
    id: 'PO-S-xvii. ★★★ PCT raises alone',
    file: PO, tests: RULES,
    find: CLASS_IN,
    to: "  if (cap.v === 'healthy') return pct.v === 'fault' ? 'STRONG' : 'IN'; /* MUTANT */",
    why: 'A percent that matches two slots raises with the capacity healthy.',
  },
  {
    id: 'PO-S-xviii. ★★★ FLOW raises alone',
    file: PO, tests: RULES,
    find: CLASS_IN,
    to: "  if (cap.v === 'healthy') return flow.v === 'fault' ? 'STRONG' : 'IN'; /* MUTANT */",
    why: 'A slot idle while counted raises (deferred to a later release, with its own dwell).',
  },
  {
    id: 'PO-S-xix. ★★★ FLAG raises alone',
    file: PO, tests: RULES,
    find: SIG_CLS,
    to: "  const cls = flag.v === 'fault' ? 'STRONG' : classify(cap, pct, flow); /* MUTANT */",
    why: 'An error code or a differing flag raises "Core out" with the capacity healthy.',
  },
  {
    id: 'PO-S-xx. ★★★ FLAG shortens the dwell',
    file: PO, tests: RULES,
    find: SIG_CLS,
    to: "  const cls = flag.v === 'fault' && cap.v === 'fault' ? 'STRONG' : classify(cap, pct, flow); /* MUTANT */",
    why: 'A flag whose meaning is unverified makes a capacity dip raise at ten minutes.',
  },
  {
    id: 'PO-S-xxi. ★★★ FLAG names a slot',
    file: PO, tests: RULES,
    find: '  const named = namedSet(cap, pct, flow);',
    to: "  const named = namedSet(cap, pct, flow) ?? (cap.v === 'fault' && flag.items.length > 0 ? [...new Set(flag.items.map((i) => i.slot))].sort((a, b) => a - b) : null); /* MUTANT */",
    why: 'A healthy slot stopped at its ceiling, its flags different, is put in the title.',
  },
  {
    id: 'PO-S-xxii. ★★★ NOCAP is counted',
    file: PO, tests: RULES,
    find: "  const counted = sig.cls === 'STRONG' || sig.cls === 'SLOW';",
    to: "  const counted = sig.cls === 'STRONG' || sig.cls === 'SLOW' || sig.cls === 'NOCAP'; /* MUTANT */",
    why: 'Percent and power raise without the capacity (not in this release).',
  },
  {
    id: 'PO-S-xxiii. ★★★ namers that disagree still name',
    file: PO, tests: RULES,
    find: '  if (!namers.every((n) => sameSet(n, set))) return null;',
    to: '  /* MUTANT */',
    why: 'The first namer wins when the percent and the power point at different slots.',
  },
  {
    id: 'PO-S-xxiv. ★★★ a named set need not be the count',
    file: PO, tests: RULES,
    find: '  if (set.length !== cap.k || !cap.candidates.some((c) => sameSet(c, set))) return null;',
    to: '  /* MUTANT */',
    why: 'One slot is named for a two-slot shortfall.',
  },
  {
    id: 'PO-S-xxv. ★★★ the percent names a slot seen carrying its share',
    file: PO, tests: RULES,
    find: "  if (flow.slots.some((f) => f.v === 'healthy' && set.includes(f.slot))) return null;",
    to: '  /* MUTANT */',
    why: 'A slot delivering power is named out on the percent alone.',
  },
  {
    id: 'PO-S-xxvi. ★★★ FLAG votes on a difference from the reference alone',
    file: PO, tests: RULES,
    find: '      if (fromOthers && fromRef) vote = true;',
    to: '      if (fromRef) vote = true; /* MUTANT */',
    why: 'Every slot changing mode together (a charge) reads as a flag fault on each.',
  },

  /* ── D: the streak and the episode ── */
  {
    id: 'PO-D-i. ★★★ healthy readings never reset a streak',
    file: PO, tests: RULES,
    find: '        if (runMet(s.inRun, POOL_OUT_IN_RESET_OBS, POOL_OUT_IN_RESET_MS)) {',
    to: '        if (obs.atMs < 0 && runMet(s.inRun, POOL_OUT_IN_RESET_OBS, POOL_OUT_IN_RESET_MS)) { /* MUTANT */',
    why: 'A capacity blip from weeks ago still counts toward a raise.',
  },
  {
    id: 'PO-D-ii. ★★★ a held capacity fault does not break a run of healthy readings',
    file: PO, tests: RULES,
    find: "    } else if (sig.cls === 'NOCAP' || cap.v === 'fault') {",
    to: "    } else if (sig.cls === 'NOCAP') { /* MUTANT */",
    why: 'Healthy, healthy, capacity short, healthy ends a streak.',
  },
  {
    id: 'PO-D-iii. ★★★ a healthy reading does not break "consecutive"',
    file: PO, tests: RULES,
    find: '        s.streak.run = 0;',
    to: '        /* MUTANT */',
    why: 'Two fault readings around a healthy one are a confirmed loss step.',
  },
  {
    id: 'PO-D-iv. ★★★ a naming conflict keeps the newer name',
    file: PO, tests: RULES,
    find: '  if (st.slots != null && !sameSet(st.slots, sig.named)) { forgetNames(st, true); return; }',
    to: '  if (st.slots != null && !sameSet(st.slots, sig.named)) { st.names = null; } /* MUTANT */',
    why: 'Readings that disagree about the slot put the later one in the title as soon as IT has been named for ten minutes, the disagreement forgotten.',
  },
  {
    id: 'PO-D-v. ★★★ the latched set follows each reading',
    file: PO, tests: RULES,
    find: '  return runMet(st.names, POOL_OUT_STRONG_MIN_OBS, POOL_OUT_STRONG_MIN_MS) ? st.slots : null;',
    to: '  return st.slots; /* MUTANT */',
    why: 'One reading naming another slot changes the title, and the announcement\'s identity with it.',
  },
  {
    id: 'PO-D-vi. ★★★ a pending name that has not met its dwell un-names the slot',
    file: PO, tests: RULES,
    find: '          else if (named != null && !(ep.slots != null && sameSet(named, ep.slots))) {',
    to: '          else if (!(named != null && ep.slots != null && sameSet(named, ep.slots))) { /* MUTANT */',
    why: 'One reading naming another slot turns "slot 1" into "slot not identified". (Before the fix round this guarded agreesWithLatch, where a count-only reading could un-name the slot; a same-count change now needs a name confirmed by its own dwell, so that line alone no longer decides it.)',
  },
  {
    id: 'PO-D-vii. ★★★ a second Core out drops the first one\'s name',
    file: PO, tests: RULES,
    find: '          setChanged(top, named, named ?? ep.slots);',
    to: '          setChanged(top, named, named); /* MUTANT */',
    why: 'A named slot is un-named when another, unidentified, joins it.',
  },
  {
    id: 'PO-D-viii. ★★★ a clear without the capacity',
    file: PO, tests: RULES,
    find: "    if (cap.v === 'healthy') {\n      /* The clear:",
    to: "    if (cap.v !== 'fault') { /* MUTANT */\n      /* The clear:",
    why: 'Readings whose capacity cannot be compared clear the alarm.',
  },
  {
    id: 'PO-D-ix. ★★★ a fast clear without power or percent evidence',
    file: PO, tests: RULES,
    find: FAST,
    to: '      const fast = runMet(run, POOL_OUT_FAST_CLEAR_MIN_OBS, POOL_OUT_FAST_CLEAR_MIN_MS); /* MUTANT */',
    why: 'Ten minutes of capacity alone clear: the dips of minutes on record would raise and clear in turn.',
  },
  {
    id: 'PO-D-x. ★★★ FLAG blocks the fast clear',
    file: PO, tests: RULES,
    find: FAST,
    to: "      const fast = evidenced && sig.flag.v !== 'fault' && runMet(run, POOL_OUT_FAST_CLEAR_MIN_OBS, POOL_OUT_FAST_CLEAR_MIN_MS); /* MUTANT */",
    why: 'A flag that stays different after the return holds the alarm.',
  },
  {
    id: 'PO-D-xi. ★★★ PCT and FLOW block the clear',
    file: PO, tests: RULES,
    find: SLOW,
    to: "      const slow = pct.v !== 'fault' && flow.v !== 'fault' && runMet(run, POOL_OUT_CLEAR_MIN_OBS, POOL_OUT_CLEAR_MIN_MS); /* MUTANT */",
    why: 'A returned slot the panel holds idle keeps the alarm standing for ever.',
  },
  {
    id: 'PO-D-xii. ★★★ FLAG blocks the clear',
    file: PO, tests: RULES,
    find: SLOW,
    to: "      const slow = sig.flag.v !== 'fault' && runMet(run, POOL_OUT_CLEAR_MIN_OBS, POOL_OUT_CLEAR_MIN_MS); /* MUTANT */",
    why: 'A standing error code keeps the alarm standing for ever.',
  },
  {
    id: 'PO-D-xiii. ★★★ a capacity fault does not start the clear over',
    file: PO, tests: RULES,
    find: "    if (cap.v === 'fault' && ep.clear != null) { ep.clear = null; changed = true; }",
    to: "    if (cap.v === 'fault' && ep.clear != null && obs.atMs < 0) { ep.clear = null; changed = true; } /* MUTANT */",
    why: 'A Core that rejoins and leaves again clears on the minutes it was in.',
  },
  {
    id: 'PO-D-xiv. ★★★ the percent vouches for a slot it could not show',
    file: PO, tests: RULES,
    find: "      const vouched = pct.v === 'consistent' ? pct.separable : [];",
    to: "      const vouched = pct.v === 'consistent' ? roster : []; /* MUTANT */",
    why: 'Slots at one percent "confirm" the return: the capacity alone clears at ten minutes.',
  },
  {
    id: 'PO-D-xv. ★★★ a count-only episode clears early without every slot carrying',
    file: PO, tests: RULES,
    find: '        : run.allFlow;',
    to: '        : run.pctOk.length > 0 || run.allFlow; /* MUTANT */',
    why: 'The percent vouches for a slot nobody named.',
  },
  {
    id: 'PO-D-xvi. ★★★ every end is called a return',
    file: PO, tests: RULES,
    find: "        const kind: PoolOutEnd['kind'] = evidenced ? 'returned' : 'capacity-only';",
    to: "        const kind: PoolOutEnd['kind'] = 'returned'; void evidenced; /* MUTANT */",
    why: '"Core back in the backup pool" over a capacity nobody confirmed.',
  },
  {
    id: 'PO-D-xvii. ★★★ the reference is taken while an episode stands',
    file: PO, tests: RULES,
    find: '  if (!streakLive && s.episode == null) {',
    to: '  if (!streakLive) { /* MUTANT */',
    why: 'A reference is adopted from a pool whose return is not yet confirmed.',
  },
  {
    id: 'PO-D-xviii. ★★★ a larger capacity is adopted whatever the slots add up to',
    file: PO, tests: RULES,
    find: '      if (Math.abs(sum - (cap.countedWh as number)) <= POOL_OUT_CAP_TOLERANCE_WH) {',
    to: '      if (sum > 0) { /* MUTANT */',
    why: 'The reference moves to a capacity its listed slots do not explain.',
  },
  {
    id: 'PO-D-xix. ★★★ the "before" percent is a held reading\'s',
    file: PO, tests: [T_REPLAY],
    find: '    if (counted) ep.lastFault = { atMs: obs.atMs, pct: obs.diag.pool.coherent ? obs.diag.pool.pct : null, capWh: cap.countedWh };',
    to: "    if (cap.v === 'fault') ep.lastFault = { atMs: obs.atMs, pct: obs.diag.pool.coherent ? obs.diag.pool.pct : null, capWh: cap.countedWh }; /* MUTANT */",
    why: 'The return notice of 2026-11-16 reads 64 % before and after: the membership step is not named.',
  },
  {
    id: 'PO-D-xx. ★★★ a clean dwell in this process on any healthy reading',
    file: PO, tests: RULES,
    find: '    if (runMet(s.proc.clean, POOL_OUT_CLEAR_MIN_OBS, POOL_OUT_CLEAR_MIN_MS)) s.proc.cleanDwell = true;',
    to: '    s.proc.cleanDwell = true; /* MUTANT */',
    why: 'The orphan hold is released by one reading: a lost state file pushes a false "Resolved".',
  },
  {
    id: 'PO-D-xxi. ★★★ the orphan hold is always released',
    file: PO, tests: RULES,
    find: '  return state.proc.raised || state.proc.cleanDwell;',
    to: '  return true; /* MUTANT */',
    why: 'A lost state file pushes "Resolved" ten minutes after boot.',
  },
  {
    id: 'PO-D-xxii. ★★ the sensor reads by freshness during an episode',
    file: PO, tests: [T_RULES],
    find: "  if (state.episode != null) return 'on';",
    to: "  if (state.episode != null && state.lastCapMs != null && nowMs - state.lastCapMs <= POOL_OUT_SENSOR_FRESH_MS) return 'on'; /* MUTANT */",
    why: 'A standing episode reads unknown as soon as the panel goes quiet.',
  },

  /* ── V: severity ── */
  {
    id: 'PO-V-i. ★★★ critical at exactly half the reference',
    file: PO, tests: RULES,
    find: HALF,
    to: "  if (ep.countedWh <= ep.baselineWh / 2) return 'critical'; /* MUTANT */",
    why: 'One of two Cores out is a critical.',
  },
  {
    id: 'PO-V-ii. ★★★ critical only under a third of the reference',
    file: PO, tests: RULES,
    find: HALF,
    to: "  if (ep.countedWh < ep.baselineWh / 3) return 'critical'; /* MUTANT */",
    why: 'Two of three Cores out is a warning.',
  },
  {
    id: 'PO-V-iii. ★★★ critical on the live capacity',
    file: PO, tests: RULES,
    find: HALF,
    to: "  if ((state.last?.cap.countedWh ?? ep.countedWh) < ep.baselineWh / 2) return 'critical'; /* MUTANT */",
    why: 'One coherent reading at 30.7 kWh during a one-Core episode is a critical with no dwell.',
  },
  {
    id: 'PO-V-iv. ★★★ a missing gridSta reads as "not 1"',
    file: PO, tests: RULES,
    find: "  if (obs.grid == null || sta == null) return 'unknown';",
    to: "  if (obs.grid == null) return 'unknown'; /* MUTANT */",
    why: 'Bodies that omit the key make a critical: the 04:22 class of false critical.',
  },
  {
    id: 'PO-V-v. ★★★ an unknown grid reads as absent',
    file: PO, tests: RULES,
    find: GRID_ABSENT,
    to: "  if (obs.grid.present === false && sta !== 1) return 'absent'; /* MUTANT */",
    why: '"Nothing can be heard" makes a critical.',
  },
  {
    id: 'PO-V-vi. ★★★ the panel\'s own reading is not required',
    file: PO, tests: RULES,
    find: GRID_ABSENT,
    to: "  if (obs.grid.present === false && !obs.grid.presenceUnknown) return 'absent'; /* MUTANT */",
    why: 'A stale veto makes a critical while the panel reads Grid OK.',
  },
  {
    id: 'PO-V-vii. ★★★ the add-on\'s verdict is not required',
    file: PO, tests: RULES,
    find: GRID_ABSENT,
    to: "  if (sta !== 1) return 'absent'; /* MUTANT */",
    why: 'One source alone makes a critical.',
  },
  {
    id: 'PO-V-viii. ★★★ the panel alone ends a grid critical',
    file: PO, tests: RULES,
    find: "  if (obs.grid.present === true && sta === 1) return 'present';",
    to: "  if (sta === 1) return 'present'; /* MUTANT */",
    why: 'The critical ends while the add-on\'s own verdict still says no grid.',
  },
  {
    id: 'PO-V-ix. ★★★ one reading with no grid is enough',
    file: PO, tests: RULES,
    find: GRID_BLOCK,
    to: "    if (s.grid.some((r) => r.g === 'absent' && obs.atMs - r.atMs >= 0 && obs.atMs - r.atMs <= POOL_OUT_GRID_MAX_AGE_MS)) { /* MUTANT */",
    why: 'A single reading makes a critical, pushed with no debounce.',
  },
  {
    id: 'PO-V-x. ★★★ an unknown grid ends a critical',
    file: PO, tests: RULES,
    find: "    } else if (s.grid.every((r) => r.g === 'present')) {",
    to: '    } else { /* MUTANT */',
    why: 'The severity flips to warning on any reading that is not "absent".',
  },

  /* ── F: the state file ── */
  {
    id: 'PO-F-i. ★★★ the episode is not restored',
    file: PO, tests: RULES,
    find: '      episode: orNull(o.episode, readEpisode),',
    to: '      episode: null, /* MUTANT */',
    why: 'A restart clears the alarm: a false "Resolved", then a new rise.',
  },
  {
    id: 'PO-F-ii. ★★★ the streak is not restored',
    file: PO, tests: RULES,
    find: '      streak: orNull(o.streak, (x) => readStreak(x)),',
    to: '      streak: null, /* MUTANT */',
    why: 'Every deploy restarts the dwell.',
  },
  {
    id: 'PO-F-iii. ★★★ the ring is not restored',
    file: PO, tests: RULES,
    find: '      ring: arr(o.ring, str, POOL_OUT_WITNESS_RING),',
    to: '      ring: [], /* MUTANT */',
    why: 'The first body after a restart is always new, even a replay.',
  },
  {
    id: 'PO-F-iv. ★★★ the grid flag is not restored',
    file: PO, tests: RULES,
    find: '    evidence: orNull(o.evidence, readEvidence), gridCritical: bool(o.gridCritical), gridAbsentAtMs: numN(o.gridAbsentAtMs),',
    to: '    evidence: orNull(o.evidence, readEvidence), gridCritical: false, gridAbsentAtMs: numN(o.gridAbsentAtMs), /* MUTANT */',
    why: 'A restart turns a critical into a warning.',
  },
  {
    id: 'PO-F-v. ★★★ an episode on file releases the orphan hold',
    file: PO, tests: RULES,
    find: '      noted,\n      proc: { raised: false, cleanDwell: false, clean: null },',
    to: '      noted,\n      proc: { raised: o.episode != null, cleanDwell: false, clean: null }, /* MUTANT */',
    why: 'What this process saw is read from a file.',
  },
  {
    id: 'PO-F-vi. ★★★ an episode with no slot out is accepted',
    file: PO, tests: RULES,
    find: '  need(k >= 1);',
    to: '  /* MUTANT */',
    why: 'A damaged file restores an alarm for zero Cores.',
  },
  {
    id: 'PO-F-vii. ★★★ slots out of order are accepted',
    file: PO, tests: RULES,
    find: 'need(a.every((x, i) => i === 0 || x > a[i - 1])); return a; };',
    to: 'return a; }; /* MUTANT */',
    why: 'A set written out of order never equals the set a reading names.',
  },

  /* ── W: the words ── */
  {
    id: 'PO-W-i. ★★★ a gloss on a code',
    file: PD, tests: [T_DIAG, T_TEXT],
    find: '  return `error code ${n}`;',
    to: "  return `error code ${n}${n >= 500 && n < 600 ? ' (battery/BMS protection band)' : ''}`; /* MUTANT */",
    why: 'One observation of code 533 is generalised into a meaning for a hundred codes.',
  },
  {
    id: 'PO-W-ii. ★★★ an entry printed in reverse byte order',
    file: PD, tests: [T_DIAG],
    find: HEX,
    to: "  return [...bytes].reverse().map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' '); /* MUTANT */",
    why: 'A byte-order reading nobody verified.',
  },
  {
    id: 'PO-W-iii. ★★★ an entry printed as one unbroken token',
    file: PD, tests: [T_DIAG, T_TEXT],
    find: HEX,
    to: "  return bytes.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(''); /* MUTANT */",
    why: 'The phone push shows the last four characters of it.',
  },
  {
    id: 'PO-W-iv. ★★★ sixteen hex digits read as base64',
    file: PD, tests: [T_DIAG],
    find: '    if (/^[0-9A-Fa-f]{16}$/.test(v)) bytes = hexBytes(v);',
    to: '    if (v.length < 0) bytes = hexBytes(v); /* MUTANT */',
    why: 'An 8-byte hex entry is printed as twelve other bytes.',
  },
  {
    id: 'PO-W-v. ★★★ zero written in hex is not empty',
    file: PD, tests: [T_DIAG],
    find: "    if (v === '' || /^0+$/.test(v)) return { kind: 'empty' };",
    to: "    if (v === '') return { kind: 'empty' }; /* MUTANT */",
    why: 'A zero entry is reported as an unrecognised value.',
  },
  {
    id: 'PO-W-vi. ★★★ zero written in base64 is read as hex',
    file: PD, tests: [T_DIAG],
    find: "    if (/^A+={0,2}$/.test(v) && v.length % 4 === 0) return { kind: 'empty' };",
    to: '    /* MUTANT */',
    why: 'Twelve zero bytes are printed as an entry of AA AA AA….',
  },
  {
    id: 'PO-W-vii. ★★★ any string is quoted as an enum token',
    file: PD, tests: [T_DIAG],
    find: '    return { token: QUOTABLE_TOKEN.test(v) ? v : null, index: -1, sent: null };',
    to: '    return { token: v, index: -1, sent: null }; /* MUTANT */',
    why: 'Whatever the cloud sends in that key is printed in a push.',
  },
  {
    id: 'PO-W-viii. ★★★ a missing isConnect reads 0',
    file: PD, tests: [T_DIAG, T_NOFALSE],
    find: '      isConnect: numOf(q[`${e}isConnect`]),',
    to: '      isConnect: numOf(q[`${e}isConnect`]) ?? 0, /* MUTANT */',
    why: 'A partial body reads as "not connected": the defect the projection has.',
  },
  {
    id: 'PO-W-ix. ★★ five entries printed',
    file: PD, tests: [T_DIAG, T_TEXT],
    find: 'export const ERR_ENTRIES_SHOWN = 4;',
    to: 'export const ERR_ENTRIES_SHOWN = 5; /* MUTANT */',
    why: 'The sentence grows past its stated bound.',
  },
  {
    id: 'PO-W-x. ★★ the prefixed enable key first',
    file: PD, tests: [T_DIAG],
    find: '      enableSet: numOf(q[`ch${n}EnableSet`]) ?? numOf(q[`pd303_mc.ch${n}EnableSet`]),',
    to: '      enableSet: numOf(q[`pd303_mc.ch${n}EnableSet`]) ?? numOf(q[`ch${n}EnableSet`]), /* MUTANT */',
    why: 'The documented key is not the one read.',
  },
  {
    id: 'PO-W-xi. ★★★ the stale shortfall while the clear is pending',
    file: PO, tests: WORDS,
    find: "  if (last.cap.v === 'healthy' && countedWh != null && ep.clear != null) {",
    to: "  if (last.cap.v === 'healthy' && countedWh != null && ep.clear != null && ctx.nowMs < 0) { /* MUTANT */",
    why: 'The lead does not say the capacity is back.',
  },
  {
    id: 'PO-W-xii. ★★★ a grid critical does not say so second',
    file: PO, tests: WORDS,
    find: '  if (gridSecond) out.push(`The panel reported no grid at ${poolOutWhen(ep.gridAbsentAtMs as number, ctx)}.`);',
    to: '  /* MUTANT */',
    why: 'The spoken critical never mentions the grid.',
  },
  {
    id: 'PO-W-xiii. ★★★ "three empty error lists" of lists that were not read',
    file: PO, tests: WORDS,
    find: '    text.push(unread.length === 0',
    to: '    text.push(unread.length >= 0 /* MUTANT */',
    why: 'A missing list is reported as empty.',
  },
  {
    id: 'PO-W-xiv. ★★★ "no error code" of a slot whose code was not read',
    file: PO, tests: WORDS,
    find: '    const code = judged.length > 0 && judged.every((x) => x.errorCodeNum === 0) ? `no error code for ${who}` : `no error-code reading for ${who}`;',
    to: '    const code = `no error code for ${who}`; void judged; /* MUTANT */',
    why: 'A missing key is reported as a zero.',
  },
  {
    id: 'PO-W-xv. ★★★ a recorded-only key is quoted to the owner',
    file: PO, tests: WORDS,
    find: "  { key: () => 'devInfo.fullCap', of: (s) => (s.fullCapWh == null ? null : String(s.fullCapWh)) },",
    to: "  { key: () => 'devInfo.fullCap', of: (s) => (s.fullCapWh == null ? null : String(s.fullCapWh)) },\n  { key: () => 'emsChgFlag', of: (s) => (s.emsChgFlag == null ? null : String(s.emsChgFlag)) }, /* MUTANT */",
    why: 'A key whose meaning is unknown, and which the review ruled out of owner text, is printed.',
  },
  {
    id: 'PO-W-xvi. ★★★ every end carries the return title',
    file: PO, tests: WORDS,
    find: "  const title = end.kind === 'returned'",
    to: '  const title = end.kind.length > 0 /* MUTANT */',
    why: '"Core back in the backup pool" for a capacity-only end.',
  },
  {
    id: 'PO-W-xvii. ★★★ a time on another day has no day',
    file: PO, tests: WORDS,
    find: '  if (now && now.ymd === at.ymd) return at.hm;',
    to: '  if (now) return at.hm; /* MUTANT */',
    why: 'A 44-hour episode reads as tonight.',
  },
  {
    id: 'PO-W-xviii. ★★★ the title takes the newest reading\'s count',
    file: PO, tests: WORDS,
    find: '  return { severity, title: poolOutTitle(ep.k, ep.slots), fault: poolOutFault(ep.k, ep.slots), detail: poolOutDetail(state, ctx), facts };',
    to: '  return { severity, title: poolOutTitle(last?.cap.k ?? ep.k, last?.pct.set ?? ep.slots), fault: poolOutFault(ep.k, ep.slots), detail: poolOutDetail(state, ctx), facts }; /* MUTANT */',
    why: 'The title moves with the readings: a new announcement identity each time.',
  },

  /* ── P: the delivery policy ── */
  {
    id: 'PO-P-i. ★★★ not pushed in quiet hours',
    file: PO, tests: [T_DELIVERY],
    find: 'export const POOL_OUT_PUSH_IN_QUIET_HOURS = true;',
    to: 'export const POOL_OUT_PUSH_IN_QUIET_HOURS = false; /* MUTANT */',
    why: 'A loss at 23:46 is one digest line at 07:00.',
  },
  {
    id: 'PO-P-ii. ★★★ the constant is not read',
    file: PO, tests: [T_DELIVERY],
    find: '    pushNow: POOL_OUT_PUSH_IN_QUIET_HOURS || !inQuietHours,',
    to: '    pushNow: !inQuietHours, /* MUTANT */',
    why: 'The policy has a second home.',
  },
  {
    id: 'PO-P-iii. ★★★ a critical is spoken in quiet hours',
    file: PO, tests: [T_DELIVERY],
    find: SPEAK,
    to: "    speak: severity === 'critical', /* MUTANT */ ",
    why: 'The house is woken by speech: not today\'s rule.',
  },
  {
    id: 'PO-P-iv. ★★★ a warning is spoken',
    file: PO, tests: [T_DELIVERY],
    find: SPEAK,
    to: '    speak: !inQuietHours, /* MUTANT */',
    why: 'One Core out with the grid present is announced.',
  },

  /* ── X: the wiring ── */
  {
    id: 'PO-X-i. ★★★ the store never folds a body',
    file: SN, tests: [T_STORE, T_MONITOR],
    find: FOLD_CALL,
    to: '    /* MUTANT */',
    why: 'The tracker, its tests and its harness exist, and nothing calls them: 2026-11-14 again.',
  },
  {
    id: 'PO-X-ii. ★★★ an MQTT-sourced quota is folded too',
    file: SN, tests: [T_STORE],
    find: FOLD_CALL,
    to: "    if (cur.projection?.kind === 'shp2') this.foldPoolOut(sn, cur, raw, nowQ, witness, latched); /* MUTANT */",
    why: 'A merged delta is not a REST body: the observation gates were measured on bodies.',
  },
  {
    id: 'PO-X-iii. ★★★ the body is stamped with the wall clock',
    file: SN, tests: [T_STORE],
    find: FOLD_CALL,
    to: "    if (source === 'rest' && cur.projection?.kind === 'shp2') this.foldPoolOut(sn, cur, raw, Date.now(), witness, latched); /* MUTANT */",
    why: 'A dwell and a streak carry measured by the clock of the process, not of the data.',
  },
  {
    id: 'PO-X-iv. ★★★ the latch is not handed to the tracker',
    file: SN, tests: [T_STORE],
    find: FOLD_CALL,
    to: "    if (source === 'rest' && cur.projection?.kind === 'shp2') this.foldPoolOut(sn, cur, raw, nowQ, witness, false); /* MUTANT */",
    why: 'New-looking bodies behind a stale-shadow latch are counted as readings.',
  },
  {
    id: 'PO-X-v. ★★★ with no grid source the grid reads absent',
    file: SN, tests: [T_STORE],
    find: '      grid = this.poolOutGridSource ? this.poolOutGridSource(sn) : null;',
    to: '      grid = this.poolOutGridSource ? this.poolOutGridSource(sn) : { present: false, presenceUnknown: false }; /* MUTANT */',
    why: 'An unknown grid read as absent: the 04:22 class of false critical.',
  },
  {
    id: 'PO-X-vi. ★★★ a grid source that fails reads absent',
    file: SN, tests: [T_STORE],
    find: '      grid = null; // a verdict that could not be formed is not known',
    to: '      grid = { present: false, presenceUnknown: false }; /* MUTANT */',
    why: 'A resolver error makes one Core out a critical.',
  },
  {
    id: 'PO-X-vii. ★★★ the state file is not loaded at construction',
    file: SN, tests: [T_STORE, T_MONITOR],
    find: '    this.loadPoolOut(opts);',
    to: '    void opts; /* MUTANT */',
    why: 'A restart forgets a standing alarm (and nothing is ever saved).',
  },
  {
    id: 'PO-X-viii. ★★ a state file in a read-only folder is believed',
    file: SN, tests: [T_STORE],
    find: '    if (!poolUnknownDirWritable(this.poolOutPath)) {',
    to: '    if (false as boolean) { /* MUTANT */',
    why: 'A file the last save could not replace restores an alarm that has ended.',
  },
  {
    id: 'PO-X-ix. ★★★ a change is not saved at once',
    file: SN, tests: [T_STORE],
    find: SAVE_WHEN,
    to: '    if (sigChanged || ((standing || this.poolOutDirty) && (sinceWrite >= POOL_OUT_PERSIST_EVERY_MS || sinceWrite < 0))) this.writePoolOut(atMs); /* MUTANT */',
    why: 'A raise followed by a restart inside the minute is lost.',
  },
  {
    id: 'PO-X-x. ★★ the state is saved on every body while a streak stands',
    file: SN, tests: [T_STORE],
    find: SAVE_WHEN,
    to: '    if (step.changed || sigChanged || ((standing || this.poolOutDirty) && (true as boolean))) this.writePoolOut(atMs); /* MUTANT */',
    why: 'A synchronous atomic write on every poll of a 44-hour episode.',
  },
  {
    id: 'PO-X-xi. ★★ the state is saved every minute with nothing standing',
    file: SN, tests: [T_STORE],
    find: SAVE_WHEN,
    to: '    if (step.changed || sigChanged || ((true as boolean) && (sinceWrite >= POOL_OUT_PERSIST_EVERY_MS || sinceWrite < 0))) this.writePoolOut(atMs); /* MUTANT */',
    why: '1,440 writes a day for a healthy pool.',
  },
  {
    id: 'PO-X-xii. ★★★ the change log reads replayed bodies',
    file: SN, tests: [T_STORE],
    find: "    if (step.skip !== 'offline' && step.skip !== 'no-witness' && step.skip !== 'latched' && step.skip !== 'replayed') {",
    to: '    if (true as boolean) { /* MUTANT */',
    why: 'A cloud serving an old body between two new ones logs two transitions that never happened.',
  },
  {
    id: 'PO-X-xiii. ★★★ no capture is written',
    file: SN, tests: [T_STORE],
    find: '    for (const kind of kinds) this.writePoolEvent(kind, atMs, role, raw, step.signals, tagged);',
    to: '    void raw; /* MUTANT */',
    why: 'The panel\'s own keys at the fault are lost again.',
  },
  {
    id: 'PO-X-xiv. ★★ captures are never pruned',
    file: SN, tests: [T_STORE],
    find: '      for (const old of drop) unlinkSync(resolve(dir, old));',
    to: '      /* MUTANT */',
    why: 'A flapping Core fills /data.',
  },
  {
    id: 'PO-X-xv. ★★★ the store always releases the orphan hold',
    file: SN, tests: [T_STORE, T_MONITOR],
    find: '    return st != null && poolOutOrphanHoldReleased(st);',
    to: '    return st != null || true; /* MUTANT */',
    why: 'A lost state file pushes "Resolved" for a Core that is still out.',
  },
  {
    id: 'PO-X-xvi. ★★★ a panel with no tracker state reads OFF',
    file: SN, tests: [T_STORE, T_HA],
    find: "      return st ? poolOutSensorState(st, nowMs) : 'unknown';",
    to: "      return st ? poolOutSensorState(st, nowMs) : 'off'; /* MUTANT */",
    why: 'Home Assistant shows "no problem" for a pool nobody has read.',
  },
  {
    id: 'PO-X-xvii. ★★★ the alert is gated on the panel being online and projected',
    file: AL, tests: [T_ALERT, T_MONITOR],
    find: '    if (!panel && !card) continue;',
    to: "    if (!panel || !panel.online || panel.projection?.kind !== 'shp2') continue; /* MUTANT */",
    why: 'The alarm leaves the set when the panel goes offline, and is absent after a restart until its first body.',
  },
  {
    id: 'PO-X-xviii. ★★★ the alert names no source panel',
    file: AL, tests: [T_ALERT, T_MONITOR],
    find: '      device: panel?.deviceName ?? (card as { device: string }).device,\n      sourceSn: sn,',
    to: '      device: panel?.deviceName ?? (card as { device: string }).device, /* MUTANT */',
    why: 'A vanish while the panel is dark is pushed as a return.',
  },
  {
    id: 'PO-X-xix. ★★★ the alert is emitted before the reserve pairs',
    file: AL, tests: [T_ALERT],
    find: '    out.push({\n      id: card?.id ?? poolOutAlertId(sn, sn === houseSn),',
    to: '    out.unshift({ /* MUTANT */\n      id: card?.id ?? poolOutAlertId(sn, sn === houseSn),',
    why: 'The alarm is emitted ahead of every reserve pair it was to follow.',
  },
  {
    id: 'PO-X-xx. ★★★ the quiet-hours flag is not taken from the delivery function',
    file: AL, tests: [T_ALERT, T_MONITOR],
    find: '      ...(poolOutDelivery(parts.severity, true).pushNow ? { pushInQuietHours: true } : {}),',
    to: '      /* MUTANT */',
    why: 'A loss at 23:46 is one digest line at 07:00, whatever the policy says.',
  },
  {
    id: 'PO-X-xxi. ★★★ every panel takes the house panel\'s id',
    file: AL, tests: [T_ALERT],
    find: '      id: card?.id ?? poolOutAlertId(sn, sn === houseSn),',
    to: '      id: card?.id ?? poolOutAlertId(sn, true), /* MUTANT */',
    why: 'Two panels with a Core out share one alert id: one card, one tracked entry.',
  },
  {
    id: 'PO-X-xxii. ★★ a lone panel with no pin and no projection is not the house panel',
    file: MB, tests: [T_ALERT],
    find: '  return panels.length === 1 ? panels[0] : undefined;',
    to: '  return undefined; /* MUTANT */',
    why: 'The id changes when the panel is first projected: a "Resolved" and a new rise for one episode.',
  },
  {
    id: 'PO-X-xxiii. ★★★ the family is not listed as energy-state',
    file: AM, tests: [T_ALERT],
    find: "  'shp2-pool-out',\n]);",
    to: '  /* MUTANT */\n]);',
    why: 'Ten long episodes and the chronic-noise rule silences the alarm.',
  },
  {
    id: 'PO-X-xxiv. ★★★ the monitor does not hand the store\'s alarms to computeAlerts',
    file: AM, tests: [T_MONITOR],
    find: '      poolOutBySn: store.poolOutAlerts(Date.now()),',
    to: '      /* MUTANT */',
    why: 'The alert exists in computeAlerts and never fires in production.',
  },
  {
    id: 'PO-X-xxv. ★★★ the quiet-hours flag is not read',
    file: AM, tests: [T_ALERT, T_MONITOR],
    find: "      const breaksThrough = (a.severity === 'critical' && CRITICAL_BREAKS_QUIET) || a.pushInQuietHours === true;",
    to: "      const breaksThrough = (a.severity === 'critical' && CRITICAL_BREAKS_QUIET); /* MUTANT */",
    why: 'The alert carries the flag and the monitor queues it for the digest.',
  },
  {
    id: 'PO-X-xxvi. ★★★ the return notice is bypassed',
    file: AM, tests: [T_MONITOR],
    find: "    const returned = kind === 'resolved' ? poolOutResolveText(alert, (sn) => store.poolOutEndNotice(sn, Date.now())) : null;",
    to: "    const returned = kind === 'never' as string ? poolOutResolveText(alert, (sn) => store.poolOutEndNotice(sn, Date.now())) : null; /* MUTANT */",
    why: 'The resolve push repeats the stale shortfall with "(condition cleared)".',
  },
  {
    id: 'PO-X-xxvii. ★★★ the return notice is used for every id',
    file: AM, tests: [T_ALERT],
    find: '  if (alert.id !== POOL_OUT_ALERT_ID && !alert.id.startsWith(`${POOL_OUT_ALERT_ID}-`)) return null;',
    to: '  /* MUTANT */',
    why: 'Another alarm\'s resolve push says a Core is back in the pool.',
  },
  {
    id: 'PO-X-xxviii. ★★★ the boot sweep does not read the orphan hold',
    file: AM, tests: [T_ALERT, T_MONITOR],
    find: '        }) || heldForHydration(id) || poolOutOrphanHeld(id, rec.sourceSn, (sn) => store.poolOutOrphanReleased(sn)),',
    to: '        }) || heldForHydration(id), /* MUTANT */',
    why: 'A lost state file: "Resolved … cleared while the add-on was restarting", ten minutes after boot, for a Core still out.',
  },
  {
    id: 'PO-X-xxix. ★★★ the orphan hold holds nothing',
    file: AM, tests: [T_ALERT, T_MONITOR],
    find: ORPHAN_HELD,
    to: '  return panelSn == null && !released(panelSn ?? id); /* MUTANT */',
    why: 'As PO-X-xxviii, through the rule itself.',
  },
  {
    id: 'PO-X-xxx. ★★ an id with no panel on record is released',
    file: AM, tests: [T_ALERT],
    find: ORPHAN_HELD,
    to: '  return panelSn != null && !released(panelSn); /* MUTANT */',
    why: 'A record written without its panel is resolved blind.',
  },
  {
    id: 'PO-X-xxxi. ★★★ the monitor does not wire the grid source',
    file: AM, tests: [T_MONITOR],
    find: '  store.setPoolOutGridSource((sn) => poolOutGridVerdict(livePoolGridBackstop(store.get().devices, sn)));',
    to: '  /* MUTANT */',
    why: 'The alarm never learns the grid: it can never be critical by the grid, and always says "not known".',
  },
  {
    id: 'PO-X-xxxii. ★★★ an unheard grid is handed over as absent',
    file: AM, tests: [T_ALERT],
    find: '  return { present: g.present, presenceUnknown: g.presenceUnknown };',
    to: '  return { present: g.present, presenceUnknown: false }; /* MUTANT */',
    why: 'An unknown grid read as absent, at the hand-over.',
  },
  {
    id: 'PO-X-xxxiii. ★★★ the recorder writes none of the pool series',
    file: RC, tests: [T_RECORDER],
    find: '          if (pool) for (const [metric, value] of poolRecordMetrics({ servedFullWh: shp.backupFullCapWh, ...pool })) push(metric, value);',
    to: '          void pool; /* MUTANT */',
    why: 'The next event is as unrecorded as 2026-11-14.',
  },
  {
    id: 'PO-X-xxxiv. ★★★ the MQTT state does not carry the field',
    file: MQ, tests: [T_HA],
    find: "      ...poolCoreOutStateFields(typeof store.poolOutSensorStatesSafe === 'function' ? store.poolOutSensorStatesSafe(Date.now()) : []),",
    to: '      /* MUTANT */',
    why: 'The entity exists and reads unknown for ever.',
  },
  {
    id: 'PO-X-xxxv. ★★ the entity is not a problem-class sensor',
    file: MQ, tests: [T_HA],
    find: "name: 'Core Out of Backup Pool', device_class: 'problem', icon:",
    to: "name: 'Core Out of Backup Pool', /* MUTANT */ icon:",
    why: 'Home Assistant shows on/off, not problem/OK.',
  },
  {
    id: 'PO-X-xxxvi. ★★★ a failure in the tracker stops the store from taking the body',
    file: SN, tests: [T_STORE],
    find: "      this.poolOutFailed('the tracker failed on a panel reading', e, 'the reading itself is taken as usual; the pool-out alarm may have missed it');",
    to: '      throw e; /* MUTANT */',
    why: 'A records-and-alerts feature takes the panel out of the alarms, the recorder and the dashboard.',
  },
  {
    id: 'PO-X-xxxvii. ★★★ a failure to word one alarm costs the monitor its pass',
    file: SN, tests: [T_STORE],
    find: `        this.poolOutFailed("a standing alarm's text could not be built", e, 'the alarm stands under its title, without its readings');`,
    to: '        if (e != null) throw e; /* MUTANT */',
    why: 'Every alarm stops being evaluated until the next restart.',
  },
  {
    id: 'PO-X-xxxviii. ★★★ an alarm that cannot be worded leaves the set',
    file: SN, tests: [T_STORE],
    find: '          if (ep) {\n            out.set(sn, {',
    to: '          if (ep && (false as boolean)) { /* MUTANT */\n            out.set(sn, {',
    why: 'A wording failure reads as a recovery: the monitor resolves a Core that is still out.',
  },
  {
    id: 'PO-X-xxxix. ★★★ a failure to form the pool series costs the evaluation',
    file: RC, tests: [T_RECORDER],
    find: '        } catch (e: any) {\n          if (!poolSeriesFailureSaid) {',
    to: '        } catch (e: any) {\n          throw e; /* MUTANT */\n          if (!poolSeriesFailureSaid) {',
    why: 'No sample of any device is written while the pool series fail.',
  },
  {
    id: 'PO-X-xl. ★★ a sensor state that cannot be read publishes nothing at all',
    file: SN, tests: [T_STORE],
    find: "      this.poolOutFailed('the sensor state could not be read', e, 'Home Assistant reads unknown');\n      return ['unknown'];",
    to: "      this.poolOutFailed('the sensor state could not be read', e, 'Home Assistant reads unknown');\n      throw e; /* MUTANT */",
    why: 'The whole state payload of Home Assistant is lost to one unreadable tracker.',
  },
  {
    id: 'PO-X-xli. ★★★ inside the add-on the store has no state file unless a caller names one',
    file: SN, tests: [T_PATH],
    find: STATE_PATH,
    to: '    this.poolOutPath = opts.poolOutPath !== undefined ? opts.poolOutPath : null; /* MUTANT */',
    why: 'Production names none: the tracker raises and alerts and saves nothing, and a restart forgets a standing alarm. Every test that names its own file still passes.',
  },
  {
    id: 'PO-X-xlii. ★★★ the state file is written beside the database outside the add-on too',
    file: SN, tests: [T_PATH],
    find: STATE_PATH,
    to: "    this.poolOutPath = opts.poolOutPath !== undefined ? opts.poolOutPath : config.dataFile('pool-out.json'); /* MUTANT */",
    why: 'Every store a test builds without a path of its own shares one file: an alarm written by one test file is restored by the next.',
  },
  {
    id: 'PO-X-xliii. ★★ inside the add-on the captures have no folder unless a caller names one',
    file: SN, tests: [T_PATH],
    find: EVENTS_DIR,
    to: '    this.poolEventsDir = opts.poolEventsDir !== undefined ? opts.poolEventsDir : null; /* MUTANT */',
    why: 'No capture of the panel\'s keys is ever on disk in production: the next event is as unread as 2026-11-14.',
  },
  {
    id: 'PO-X-xliv. ★★ captures are written beside the database outside the add-on too',
    file: SN, tests: [T_PATH],
    find: EVENTS_DIR,
    to: "    this.poolEventsDir = opts.poolEventsDir !== undefined ? opts.poolEventsDir : resolve(config.dataRoot, 'pool-events'); /* MUTANT */",
    why: 'A test run leaves capture files in the folder every other store reads.',
  },
  {
    id: 'PO-X-xlviii. ★★★ the reader\'s output rides on the projection',
    file: SN, tests: [T_STORE],
    find: '    this.poolDiagBySn.set(sn, { diag, atMs });',
    to: '    this.poolDiagBySn.set(sn, { diag, atMs }); (cur.projection as unknown as Record<string, unknown>).poolDiag = diag; /* MUTANT */',
    why: 'Every flag, code and error list of the panel is cloned to the analytics worker on each throttle tick and served to every client: the scope keeps it in a store side map.',
  },
  {
    id: 'PO-X-xlv. ★★★ a restored alarm with no push on record is seeded as already announced',
    file: AM, tests: [T_ALERT, T_MONITOR],
    find: BOOT_SEED,
    to: '  /* MUTANT */',
    why: 'A restart in the minute between the raise and its push: the alarm stands for the whole episode and never reaches the phone.',
  },
  {
    id: 'PO-X-xlvi. ★★★ a restored alarm is never taken as announced',
    file: AM, tests: [T_ALERT, T_MONITOR],
    find: BOOT_SEED,
    to: '  if (p.alert.id === POOL_OUT_ALERT_ID || p.alert.id.startsWith(`${POOL_OUT_ALERT_ID}-`)) return false; /* MUTANT */',
    why: 'Every restart pushes the standing alarm again.',
  },
  {
    id: 'PO-X-xlvii. ★★ every panel alert standing at a restart is owed a push',
    file: AM, tests: [T_ALERT],
    find: BOOT_SEED,
    to: "  if (p.alert.id.startsWith('shp2-')) return p.alreadyNotified; /* MUTANT */",
    why: 'The clause is this alarm\'s alone: another warning standing at boot is pushed after every restart.',
  },

  /* ── R: the record ── */
  {
    id: 'PO-R-i. ★★★ a flag the panel did not send is recorded as off',
    file: PR, tests: [T_RECORD],
    find: '    if (v == null) return;\n    sent += 2 ** i;',
    to: '    sent += 2 ** i; /* MUTANT */\n    if (v == null) return;',
    why: 'A partial body reads as "not connected" in the record.',
  },
  {
    id: 'PO-R-ii. ★★★ a key ending .sn is captured',
    file: PR, tests: [T_RECORD, T_STORE],
    find: "  if (CAPTURE_NEVER.has(key.slice(key.lastIndexOf('.') + 1))) return false;",
    to: '  /* MUTANT */',
    why: 'Device serials in a file under /data that a debug view lists.',
  },
  {
    id: 'PO-R-iii. ★★★ an identifier-shaped value is captured',
    file: PR, tests: [T_RECORD],
    find: "  if (typeof value === 'string' && ID_SHAPED.test(value)) return false;",
    to: '  /* MUTANT */',
    why: 'A serial under a key the allowlist did not expect.',
  },
  {
    id: 'PO-R-iv. ★★★ the capture is not an allowlist',
    file: PR, tests: [T_RECORD, T_STORE],
    find: CAPTURE_TOP,
    to: '  return value !== null && primitive(value); /* MUTANT */',
    why: 'Every scalar of the body is captured, whatever its block.',
  },
  {
    id: 'PO-R-v. ★★ a top-level list is captured',
    file: PR, tests: [T_RECORD],
    find: CAPTURE_TOP,
    to: '  return top && value !== null && (primitive(value) || Array.isArray(value)); /* MUTANT */',
    why: 'The allowlist says top-level SCALARS.',
  },
  {
    id: 'PO-R-vi. ★★ the capture has no size cap',
    file: PR, tests: [T_RECORD],
    find: '    if (size + add > POOL_EVENT_MAX_BYTES) { truncated = true; continue; }',
    to: '    /* MUTANT */',
    why: 'Twenty files of any size.',
  },
  {
    id: 'PO-R-vii. ★★★ a relay counter logs a line each time it moves',
    file: PR, tests: [T_RECORD],
    find: '    if (CARRIED.test(key)) {',
    to: '    if (false as boolean) { /* MUTANT */',
    why: 'About thirty lines a day per relay: most of the log.',
  },
  {
    id: 'PO-R-viii. ★★ the carried counters are not said at a tracker event',
    file: PR, tests: [T_RECORD],
    find: '  if (carried.length > 0 && (lines.length > 0 || flush)) {',
    to: '  if (carried.length > 0 && lines.length > 0) { /* MUTANT */',
    why: 'A relay that opened at the loss instant is not in the log beside the raise.',
  },
  {
    id: 'PO-R-ix. ★★★ an error code standing at the first reading is not said',
    file: PR, tests: [T_RECORD],
    find: '      if (s.errorCodeNum != null && s.errorCodeNum !== 0) lines.push(`pool-diag: slot ${s.slot} errorCodeNum reads ${s.errorCodeNum} at the first reading.`);',
    to: '      /* MUTANT */',
    why: 'A code present when the add-on starts is never logged.',
  },
  {
    id: 'PO-R-x. ★★★ the raw capacity series records the served capacity',
    file: PR, tests: [T_RECORD],
    find: "    out.push(['backup_full_raw_wh', d.pool.fullCapWh], ['backup_pct_raw', d.pool.pct]);",
    to: "    out.push(['backup_full_raw_wh', p.servedFullWh ?? null], ['backup_pct_raw', d.pool.pct]); /* MUTANT */",
    why: 'A held trio hides the step in both series.',
  },
  {
    id: 'PO-R-xi. ★★★ slots are counted on a capacity the tracker could not judge',
    file: PR, tests: [T_RECORD],
    find: "      : cap.v === 'fault' && cap.k != null ? p.signals.roster.length - cap.k : null]);",
    to: "      : cap.v === 'fault' && cap.k != null ? p.signals.roster.length - cap.k : p.signals.roster.length]); /* MUTANT */",
    why: 'An unknown capacity is recorded as "all counted".',
  },
  {
    id: 'PO-R-xii. ★★ an unidentified slot is not marked in the mask',
    file: PR, tests: [T_RECORD],
    find: ' + (ep.slots == null || ep.slots.length < ep.k ? POOL_OUT_MASK_UNIDENTIFIED : 0)]);',
    to: ' + 0]); /* MUTANT */',
    why: 'An alarm with no slot named records as "no slot out".',
  },
  {
    id: 'PO-R-xiii. ★★★ no panel at all reads OFF',
    file: PR, tests: [T_RECORD, T_HA],
    find: PLANT_OFF,
    to: "  return panels.every((p) => p === 'off') ? 'OFF' : null; /* MUTANT */",
    why: '"No problem" published for a plant with no panel read.',
  },
  {
    id: 'PO-R-xiv. ★★★ one panel off is enough for OFF',
    file: PR, tests: [T_RECORD, T_HA],
    find: PLANT_OFF,
    to: "  return panels.some((p) => p === 'off') ? 'OFF' : null; /* MUTANT */",
    why: 'A second panel nobody has read is published as fine.',
  },
  /* ═════════ the fix round of the three reviews ═════════ */

  /* (L) what a raise latches */
  {
    id: 'PO-L-i. ★★★ a reading more slots short takes the streak\'s count (the reading that completes the dwell decides)',
    file: PO, tests: RULES,
    find: '  if (k > st.k) {\n    if (st.more != null && !withinStreakGap(st.more, obs.atMs)) st.more = null;',
    to: '  if (k > st.k) { st.k = k; forgetNames(st, false); }\n  if (false as boolean) { /* MUTANT */\n    if (st.more != null && !withinStreakGap(st.more, obs.atMs)) st.more = null;',
    why: 'Ten readings one Core short and one reading two short at minute 10 raise "2 Cores out", critical, pushed at any hour.',
  },
  {
    id: 'PO-L-ii. ★★★ a reading fewer slots short does not take the streak over',
    file: PO, tests: RULES,
    find: '  if (k < st.k) {\n    st.more = { ...st, before: null, more: st.more };',
    to: '  if (false as boolean) { /* MUTANT */\n    st.more = { ...st, before: null, more: st.more };',
    why: 'Fifteen minutes two short and one reading one short raise for two Cores on readings that span fourteen minutes.',
  },
  {
    id: 'PO-L-iii. ★★★ the larger count\'s tally is thrown away when a smaller one takes the streak over',
    file: PO, tests: RULES,
    find: '    st.more = { ...st, before: null, more: st.more };',
    to: '    st.more = null; /* MUTANT */',
    why: 'Two Cores out for fifteen minutes, one reading one short: critical comes fifteen minutes later than its readings support.',
  },
  {
    id: 'PO-L-iv. ★★★ the largest count read is latched whether or not its own readings met a dwell',
    file: PO, tests: RULES,
    find: '  for (let m = st; m != null; m = m.more) if (dwellMet(m) != null) top = m;',
    to: '  for (let m = st; m != null; m = m.more) top = m; /* MUTANT */',
    why: 'One reading two short inside a one-Core dwell is latched at the raise.',
  },
  {
    id: 'PO-L-v. ★★★ the capacity the severity reads is the completing reading\'s',
    file: PO, tests: RULES,
    find: '          baselineWh: s.baseline?.poolCapWh ?? top.expectedWh, expectedWh: top.expectedWh, countedWh: top.countedWh,',
    to: '          baselineWh: s.baseline?.poolCapWh ?? top.expectedWh, expectedWh: top.expectedWh, countedWh: cap.countedWh as number, /* MUTANT */',
    why: 'Critical on one reading at 30.7 kWh.',
  },
  {
    id: 'PO-L-vi. ★★ the smallest count is latched though a larger one has met its own dwell',
    file: PO, tests: RULES,
    find: '        const top = confirmedCount(st) ?? st;',
    to: '        const top = st; /* MUTANT */',
    why: 'Two Cores out for fifteen minutes with one reading one short among them raise as one Core, a warning.',
  },
  {
    id: 'PO-L-vii. ★★★ a larger count on its way is dropped at the raise',
    file: PO, tests: RULES,
    find: '        const pending = slots == null && top.slots != null && !top.conflict ? { ...top, before: null } : top.more;',
    to: '        const pending = slots == null && top.slots != null && !top.conflict ? { ...top, before: null, more: null } : null; /* MUTANT */',
    why: 'A second Core that left inside the first dwell starts its dwell again at the raise.',
  },
  {
    id: 'PO-L-viii. ★★ a set the readings agree on is thrown away at a count-only raise',
    file: PO, tests: RULES,
    find: '        const pending = slots == null && top.slots != null && !top.conflict ? { ...top, before: null } : top.more;',
    to: '        const pending = top.more; /* MUTANT */',
    why: 'Nine minutes of readings naming slot 1 count for nothing: the title names it ten minutes after the raise, not one.',
  },
  {
    id: 'PO-L-ix. ★★★ a slot is named as soon as the streak\'s dwell is met, however few readings named it',
    file: PO, tests: RULES,
    find: '  return runMet(st.names, POOL_OUT_STRONG_MIN_OBS, POOL_OUT_STRONG_MIN_MS) ? st.slots : null;',
    to: '  return dwellMet(st) != null ? st.slots : null; /* MUTANT */',
    why: 'One reading with slot 2 at 0 W in fifteen count-only minutes puts "slot 2" in the title, and nothing corrects it.',
  },
  {
    id: 'PO-L-x. ★★★ one reading at the latched count does not end a pending decrease',
    file: PO, tests: RULES,
    find: '      ep.less = null;\n      // A pending change whose last reading is more than the streak gap old is over, whatever this reading says.',
    to: '      /* MUTANT */\n      // A pending change whose last reading is more than the streak gap old is over, whatever this reading says.',
    why: 'Stale one-short readings among two-short ones pile up, and a critical is taken down to a warning.',
  },
  {
    id: 'PO-L-xi. ★★★ a decrease on one reading',
    file: PO, tests: RULES,
    find: '      if (dwellMet(ls) != null) {',
    to: '      if (ls.counted >= 1) { /* MUTANT */',
    why: 'One reading one short takes "2 Cores out" down to one.',
  },
  {
    id: 'PO-L-xii. ★★ a decrease goes to the SMALLEST of the counts read',
    file: PO, tests: RULES,
    find: '      if (k > ls.k) { ls.k = k; forgetNames(ls, false); }',
    to: '      if (k < ls.k) { ls.k = k; forgetNames(ls, false); } /* MUTANT */',
    why: 'Readings one and two short by turns take three Cores out down to one, a warning, while two are still read out.',
  },
  {
    id: 'PO-L-xiii. ★★ a pending change is never dropped by its age',
    file: PO, tests: RULES,
    find: '      if (ep.change != null && !withinStreakGap(ep.change, obs.atMs)) ep.change = null;\n      if (!agreesWithLatch(ep, cap.k as number, sig.named)) {',
    to: '      /* MUTANT */\n      if (!agreesWithLatch(ep, cap.k as number, sig.named)) {',
    why: 'Single readings two short, hours apart, add up to a critical.',
  },
  {
    id: 'PO-L-xiv. ★★ a larger count\'s tally runs across any gap',
    file: PO, tests: RULES,
    find: '    if (st.more != null && !withinStreakGap(st.more, obs.atMs)) st.more = null;',
    to: '    /* MUTANT */',
    why: 'One reading two short and another twenty minutes later are counted as one run.',
  },

  /* (B) blindness and the reference */
  {
    id: 'PO-B-i. ★★★ a reading whose capacity cannot be judged runs no blind clock',
    file: PO, tests: RULES,
    find: "  if (cap.v !== 'unknown') s.blind = null;",
    to: '  if (true as boolean) s.blind = null; /* MUTANT */',
    why: 'A slot with no capacity on record leaves the alarm blind for hours with nothing said at warn.',
  },
  {
    id: 'PO-B-ii. ★★ a slot with no capacity on record is not said',
    file: PO, tests: RULES,
    find: "  if (cap.reason === 'no-slot-capacity') note('no-slot-capacity',",
    to: "  if (false as boolean) note('no-slot-capacity', /* MUTANT */",
    why: 'Two hours of held readings and not one log line.',
  },
  {
    id: 'PO-B-iii. ★★ a capacity above the reference is not said',
    file: PO, tests: RULES,
    find: "  if (cap.reason === 'over') note('over',",
    to: "  if (false as boolean) note('over', /* MUTANT */",
    why: 'A capacity the reference cannot explain is held in silence.',
  },
  {
    id: 'PO-B-iv. ★★★ a reference that leaves a slot out is adopted in silence',
    file: PO, tests: [T_RULES, T_MONITOR],
    find: '        if (s.baseline == null && leftOut.length > 0) {',
    to: '        if (false as boolean) { /* MUTANT */',
    why: 'A lost state file with a Core unplugged: the smaller reference is taken and nothing says a Core may be outside it.',
  },
  {
    id: 'PO-B-v. ★★ every update of such a reference says it again',
    file: PO, tests: RULES,
    find: '        if (s.baseline == null && leftOut.length > 0) {',
    to: '        if (leftOut.length > 0) { /* MUTANT */',
    why: 'A two-Core home is warned at every capacity update.',
  },
  {
    id: 'PO-B-vi. ★★★ healthy capacity against ANY roster releases the boot sweep\'s hold',
    file: PO, tests: [T_RULES, T_MONITOR],
    find: '    s.proc.clean = roster.length === SHP2_SOURCE_SLOTS ? extendRun(s.proc.clean, obs.atMs) : null;',
    to: '    s.proc.clean = extendRun(s.proc.clean, obs.atMs); /* MUTANT */',
    why: 'A lost state file with a Core unplugged pushes "Resolved" thirty minutes after the restart, while the Core is still out.',
  },
  {
    id: 'PO-B-vii. ★★★ the reference is enlarged while a streak stands',
    file: PO, tests: RULES,
    find: '  if (!streakLive && s.episode == null) {',
    to: '  if (s.episode == null) { /* MUTANT */',
    why: 'A reference is taken from a pool whose capacity is in the middle of a dwell.',
  },
  {
    id: 'PO-B-viii. ★★ a streak past its gap still holds every adoption back',
    file: PO, tests: RULES,
    find: '  const streakLive = s.streak != null && withinStreakGap(s.streak, obs.atMs);',
    to: '  const streakLive = s.streak != null; /* MUTANT */',
    why: 'One stale short body followed by readings that only hold keeps a grown pool from ever being adopted.',
  },
  {
    id: 'PO-B-ix. ★★ the blind clock runs across a restart',
    file: PO, tests: RULES,
    find: '  return carried ? { ...blind, lastMs: atMs } : { sinceMs: atMs, lastMs: atMs, warned: false };',
    to: '  return blind != null ? { ...blind, lastMs: atMs } : { sinceMs: atMs, lastMs: atMs, warned: false }; void carried; /* MUTANT */',
    why: '"No usable panel reading for 200 min while the panel is fresh" after three hours with the add-on down.',
  },
  {
    id: 'PO-T-lxxi. ★★ the 10-minute dwell is measured over the whole streak',
    file: PO, tests: RULES,
    find: "st.lastStrongMs - st.firstStrongMs >= POOL_OUT_STRONG_MIN_MS) return 'strong';",
    to: "st.lastMs - st.firstMs >= POOL_OUT_STRONG_MIN_MS) return 'strong'; /* MUTANT */",
    why: 'Nine capacity-only minutes and six STRONG readings in five raise at minute 14.',
  },
  {
    id: 'PO-V-xi. ★★ a grid reading dated after the newest one counts as fresh',
    file: PO, tests: RULES,
    find: "r.g === 'absent' && obs.atMs - r.atMs >= 0 && obs.atMs - r.atMs <= POOL_OUT_GRID_MAX_AGE_MS",
    to: "r.g === 'absent' && obs.atMs - r.atMs <= POOL_OUT_GRID_MAX_AGE_MS /* MUTANT */",
    why: 'A clock stepped back makes two old readings and one new one "three consecutive", and the alarm critical.',
  },

  /* the state file: every field the parser restores */
  {
    id: 'PO-F-viii. ★★ the skip run is not restored',
    file: PO, tests: RULES,
    find: '      skip: orNull(o.skip, (x) => { const k = obj(x); return { reason: oneOf(k.reason, SKIPS), n: count(k.n) }; }),',
    to: '      skip: null, /* MUTANT */',
    why: 'A restart starts the count of polls before a blind conversion again.',
  },
  {
    id: 'PO-F-ix. ★★ the blind clock is not restored',
    file: PO, tests: RULES,
    find: '      blind: orNull(o.blind, (x) => { const b = obj(x); return { sinceMs: num(b.sinceMs), lastMs: b.lastMs == null ? num(b.sinceMs) : num(b.lastMs), warned: bool(b.warned) }; }),',
    to: '      blind: null, /* MUTANT */',
    why: 'A restart every twenty minutes and the 30-minute WARN is never said.',
  },
  {
    id: 'PO-F-x. ★★ the run of healthy readings against a streak is not restored',
    file: PO, tests: RULES,
    find: '      inRun: orNull(o.inRun, readRun),',
    to: '      inRun: null, /* MUTANT */',
    why: 'A restart between two healthy readings keeps a streak that should have ended.',
  },
  {
    id: 'PO-F-xi. ★★ the capacity-above-reference run is not restored',
    file: PO, tests: RULES,
    find: '      grow: orNull(o.grow, readRun),',
    to: '      grow: null, /* MUTANT */',
    why: 'A restart starts the adoption dwell of a grown pool again.',
  },
  {
    id: 'PO-F-xii. ★★★ a pending change is not restored',
    file: PO, tests: RULES,
    find: '    change: orNull(o.change, (x) => readStreak(x)),',
    to: '    change: null, /* MUTANT */',
    why: 'A second Core nine minutes into its dwell starts again at every restart.',
  },
  {
    id: 'PO-F-xiii. ★★ a pending decrease is not restored',
    file: PO, tests: RULES,
    find: '    less: orNull(o.less, (x) => readStreak(x)),',
    to: '    less: null, /* MUTANT */',
    why: 'A Core back while another is out starts its dwell again at every restart.',
  },
  {
    id: 'PO-F-xiv. ★★ the naming run is not restored',
    file: PO, tests: RULES,
    find: '    k: count(o.k), slots: slotSetN(o.slots), conflict: bool(o.conflict), names: orNull(o.names, readRun),',
    to: '    k: count(o.k), slots: slotSetN(o.slots), conflict: bool(o.conflict), names: null, /* MUTANT */',
    why: 'A restart forgets how long a slot has been named.',
  },
  {
    id: 'PO-F-xv. ★★★ a larger count on its way is not restored',
    file: PO, tests: RULES,
    find: '    more: orNull(o.more, (x) => readStreak(x, depth + 1)),',
    to: '    more: null, /* MUTANT */',
    why: 'A restart inside the dwell forgets that the pool read two Cores short.',
  },
  {
    id: 'PO-F-xvi. ★★ a chain of larger counts of any depth is accepted',
    file: PO, tests: RULES,
    find: '  need(depth < SHP2_SOURCE_SLOTS);',
    to: '  /* MUTANT */',
    why: 'A file this code never wrote is restored as state.',
  },

  /* (Y) words, the sensor, the reader, the record */
  {
    id: 'PO-Y-i. ★★★ the sensor reads OFF on a capacity that reads short for an hour',
    file: PO, tests: [T_RULES, T_HA],
    find: "  if (healthyMs !== capMs && (healthyMs == null || capMs - healthyMs > POOL_OUT_SLOW_MIN_MS)) return 'unknown';",
    to: '  void healthyMs; /* MUTANT */',
    why: '"No problem" in Home Assistant while the capacity is one slot short and held.',
  },
  {
    id: 'PO-Y-ii. ★★ the sensor reads unknown through the whole dwell',
    file: PO, tests: [T_RULES, T_HA, T_STORE],
    find: "  if (healthyMs !== capMs && (healthyMs == null || capMs - healthyMs > POOL_OUT_SLOW_MIN_MS)) return 'unknown';",
    to: "  if (healthyMs !== capMs) return 'unknown'; /* MUTANT */",
    why: 'Every one-reading dip flips the sensor to unknown.',
  },
  {
    id: 'PO-Y-iii. ★★★ "after N min under it" of an episode with healthy readings between its short ones',
    file: PO, tests: WORDS,
    find: '  return `it first read under that sum at ${poolOutWhen(sinceMs, ctx)}, ${poolOutDuration(backMs - sinceMs)} earlier`;',
    to: '  return `after ${poolOutDuration(backMs - sinceMs)} under it`; void ctx; /* MUTANT */',
    why: 'Three two-minute dips in twelve minutes are announced as twelve minutes under the sum.',
  },
  {
    id: 'PO-Y-iv. ★★★ one healthy reading is said as "has read … since"',
    file: PO, tests: WORDS,
    find: '    if (ep.clear.n < 2) return `One reading, at',
    to: '    if (false as boolean) return `One reading, at',
    why: 'One stale healthy body and then nothing: the lead says the capacity "has read" whole "since" then, for an hour.',
  },
  {
    id: 'PO-Y-v. ★★ with one healthy reading the "first read under" sentence is dropped',
    file: PO, tests: WORDS,
    find: "  if (!(last != null && last.cap.v === 'healthy' && ep.clear != null && ep.clear.n >= 2)) out.push(sinceSentence(ep, ctx));",
    to: "  if (!(last != null && last.cap.v === 'healthy' && ep.clear != null)) out.push(sinceSentence(ep, ctx)); /* MUTANT */",
    why: 'The detail no longer says since when the capacity read short.',
  },
  {
    id: 'PO-Y-vi. ★★ a slot with no connection flag is called "not listed" on the card',
    file: PO, tests: WORDS,
    find: "r.isConnect == null ? 'no connection flag' : r.isConnect === 1 ? 'listed' : 'not listed'",
    to: "r.isConnect == null ? 'not listed' : r.isConnect === 1 ? 'listed' : 'not listed' /* MUTANT */",
    why: 'The card says what the detail beside it denies.',
  },
  {
    id: 'PO-Y-vii. ★★★ the percent step is said to be "not charging"',
    file: PO, tests: WORDS,
    find: 'the capacity it is a percent of changed between those two readings, so that step is not a measure of ${step > 0 ? \'charging\' : \'discharge\'}.`);',
    to: 'that step is the change in which slots are counted, not ${step > 0 ? \'charging\' : \'a discharge\'}.`); /* MUTANT */',
    why: 'A pool charging at its full rate gains three points in five minutes: "not charging" is then partly false.',
  },
  {
    id: 'PO-Y-viii. ★★★ two Cores back on different evidence are said confirmed by one reading',
    file: PO, tests: WORDS,
    find: "  } else if (end.kind === 'returned' && named != null && named.length === end.k) {",
    to: "  } else if (end.kind === 'returned' && named != null && named.length === end.k + 99) { /* MUTANT */",
    why: '"A reading has shown every slot carrying its share" when no reading did.',
  },
  {
    id: 'PO-Y-ix. ★★ the Grid fact lags the detail',
    file: PO, tests: WORDS,
    find: "ep.gridCritical ? (last.grid === 'present' ? 'not detected; present on the newest reading' : 'not detected')",
    to: "ep.gridCritical ? 'not detected' /* MUTANT */",
    why: 'The card says "not detected" beside a detail that says the newest reading shows the grid present.',
  },
  {
    id: 'PO-Y-xii. ★★ the count sentence is said when the counts agree, and not when they differ',
    file: PO, tests: WORDS,
    find: "  if (last != null && last.cap.v === 'fault' && last.cap.k != null && last.cap.k !== ep.k) {",
    to: "  if (last != null && last.cap.v === 'fault' && last.cap.k != null && last.cap.k === ep.k) { /* MUTANT */",
    why: 'A title that says one Core over a lead that says two slots, with nothing to say which the alarm stands at.',
  },
  {
    id: 'PO-Y-x. ★★★ the reader keeps every non-empty entry of an error list',
    file: PD, tests: [T_DIAG],
    find: '    if (entries.length < ERR_ENTRIES_KEPT) entries.push({',
    to: '    if (true as boolean) entries.push({ /* MUTANT */',
    why: 'A list of 65 entries writes a state the next start rejects: a standing alarm is not restored.',
  },
  {
    id: 'PO-Y-xi. ★★ a list\'s count is the number kept',
    file: PD, tests: [T_DIAG],
    find: '  return { length: v.length, count, entries };',
    to: '  return { length: v.length, count: entries.length, entries }; void count; /* MUTANT */',
    why: '"Holds 64 entries" of a list that holds 100.',
  },
  {
    id: 'PO-R-xv. ★★ every change in one reading has its own line, however many',
    file: PR, tests: [T_RECORD],
    find: '  lines = moved.length > POOL_DIAG_LINES_MAX',
    to: '  lines = (false as boolean) /* MUTANT */',
    why: 'A body missing the panel\'s block of keys is 64 lines, and 64 more when it returns.',
  },
  {
    id: 'PO-R-xvi. ★★ twelve changes are one line',
    file: PR, tests: [T_RECORD],
    find: 'export const POOL_DIAG_LINES_MAX = 12;',
    to: 'export const POOL_DIAG_LINES_MAX = 11; /* MUTANT */',
    why: 'A slot\'s charge start is folded into one line at the limit.',
  },
  {
    id: 'PO-R-xvii. ★★ thirteen changes are thirteen lines',
    file: PR, tests: [T_RECORD],
    find: 'export const POOL_DIAG_LINES_MAX = 12;',
    to: 'export const POOL_DIAG_LINES_MAX = 13; /* MUTANT */',
    why: 'The limit moved up by one.',
  },
  {
    id: 'PO-R-xviii. ★★★ an identifier inside a list is captured',
    file: PR, tests: [T_RECORD],
    find: '  if (listed) return primitive(value) || (Array.isArray(value) && value.length <= 64 && value.every(listElement));',
    to: '  if (listed) return primitive(value) || (Array.isArray(value) && value.length <= 64 && value.every(primitive)); /* MUTANT */',
    why: 'A serial sent as a list element is written to a capture file.',
  },
  {
    id: 'PO-R-xix. ★★ an error-list entry in hex is taken for an identifier',
    file: PR, tests: [T_RECORD],
    find: "const listElement = (v: unknown): boolean => primitive(v) && !(typeof v === 'string' && ID_SHAPED.test(v) && !HEX_ONLY.test(v));",
    to: "const listElement = (v: unknown): boolean => primitive(v) && !(typeof v === 'string' && ID_SHAPED.test(v)); /* MUTANT */",
    why: 'The error lists, the very thing a capture is for, are left out of it.',
  },
  {
    id: 'PO-R-xx. ★★★ the oldest capture goes first, whatever its kind',
    file: PR, tests: [T_RECORD, T_STORE],
    find: '  const drop = older.filter((n) => /-first-fault(?:-p\\d)?\\.json$/.test(n)).slice(0, over);',
    to: '  const drop: string[] = []; /* MUTANT */',
    why: 'A capacity that dips for a reading every few minutes pushes the capture of a raise out of the twenty kept.',
  },
  {
    id: 'PO-R-xxi. ★★ the capture just written may be the one to go',
    file: PR, tests: [T_RECORD],
    find: '  const older = all.slice(0, -1);',
    to: '  const older = all; /* MUTANT */',
    why: 'With twenty raises and ends on disk a new first-fault capture is deleted as soon as it is written.',
  },
  {
    id: 'PO-R-xxii. ★★ a card with another alert\'s id is restored',
    file: PR, tests: [T_RECORD, T_STORE],
    find: '    if (id !== idStem && id !== `${idStem}-${sn}`) continue;',
    to: '    /* MUTANT */',
    why: 'A hand-edited or damaged state file moves the alarm to an id of another panel.',
  },

  /* (K) the store */
  {
    id: 'PO-K-i. ★★★ the id and the name are not latched at the raise',
    file: SN, tests: [T_STORE, T_BOOT],
    find: "    if (kinds.includes('raised')) this.poolOutCard(sn);",
    to: '    /* MUTANT */',
    why: 'A restart before the first monitor pass has nothing on file to show the alarm under.',
  },
  {
    id: 'PO-K-ii. ★★ the latch outlives its alarm',
    file: SN, tests: [T_STORE],
    find: "    if (kinds.includes('ended')) this.poolOutCardBySn.delete(sn);",
    to: '    /* MUTANT */',
    why: 'The next alarm on that panel is shown under the id and the name of the last one.',
  },
  {
    id: 'PO-K-iii. ★★★ the latch is not saved',
    file: SN, tests: [T_STORE, T_BOOT],
    find: '      atomicWriteFileSync(path, withPoolOutCards(withPoolDiagSigs(serializePoolOutFile(this.poolOutBySn), this.poolDiagSigBySn), this.poolOutCardBySn));',
    to: '      atomicWriteFileSync(path, withPoolDiagSigs(serializePoolOutFile(this.poolOutBySn), this.poolDiagSigBySn)); /* MUTANT */',
    why: 'A restart into a cloud outage: the alarm is absent from the published set for the length of the outage.',
  },
  {
    id: 'PO-K-iv. ★★★ the latch is not restored',
    file: SN, tests: [T_STORE, T_BOOT],
    find: '      this.poolOutCardBySn = new Map([...cards].filter(([sn]) => panels.get(sn)?.episode != null));',
    to: '      this.poolOutCardBySn = new Map(); void cards; /* MUTANT */',
    why: 'A restart into a cloud outage: the alarm is absent from the published set for the length of the outage.',
  },
  {
    id: 'PO-K-v. ★★ a latch on file for a panel with no alarm is restored',
    file: SN, tests: [T_STORE],
    find: '      this.poolOutCardBySn = new Map([...cards].filter(([sn]) => panels.get(sn)?.episode != null));',
    to: '      this.poolOutCardBySn = new Map(cards); /* MUTANT */',
    why: 'The next alarm on that panel is shown under a stale name.',
  },
  {
    id: 'PO-K-vi. ★★★ a second alarm takes the bare id though another holds it',
    file: SN, tests: [T_STORE],
    find: '    const taken = [...this.poolOutCardBySn].some(([other, c]) => other !== sn && c.id === POOL_OUT_ALERT_ID);',
    to: '    const taken = false as boolean; /* MUTANT */',
    why: 'Two panels with a Core out share one alert id: one card, one tracked entry.',
  },
  {
    id: 'PO-K-vii. ★★★ the alert\'s id follows the house pin of the moment',
    file: AL, tests: [T_ALERT],
    find: '      id: card?.id ?? poolOutAlertId(sn, sn === houseSn),',
    to: '      id: poolOutAlertId(sn, sn === houseSn), /* MUTANT */',
    why: 'A house pin that moves resolves one card and pushes another for the same episode.',
  },
  {
    id: 'PO-K-viii. ★★★ no alert without a device list',
    file: AL, tests: [T_ALERT, T_BOOT],
    find: '    if (!panel && !card) continue;',
    to: '    if (!panel) continue; /* MUTANT */',
    why: 'A restart into a cloud outage: the alarm is absent from the dashboard, the counts and the broadcast.',
  },
  {
    id: 'PO-K-ix. ★★★ a state file value that cannot be restored stops the add-on from starting',
    file: SN, tests: [T_STORE],
    find: '    } catch (e) {\n      this.poolOutBySn = new Map();\n      this.poolDiagSigBySn = new Map();',
    to: '    } catch (e) {\n      if (this.poolOutPath != null) throw e; /* MUTANT */\n      this.poolOutBySn = new Map();\n      this.poolDiagSigBySn = new Map();',
    why: 'The constructor throws, and nothing of the add-on runs.',
  },
  {
    id: 'PO-K-x. ★★★ a file that cannot be read is not kept',
    file: SN, tests: [T_STORE],
    find: '        atomicWriteFileSync(`${this.poolOutPath}.unread`, fileText);',
    to: '        /* MUTANT */',
    why: 'A newer version\'s state file is destroyed by the first save after a rollback.',
  },
  {
    id: 'PO-K-xi. ★★ a copy is kept of a file that was read',
    file: SN, tests: [T_STORE],
    find: '    if (rejected > 0) {\n      const kept = `${basename(this.poolOutPath)}.unread`;',
    to: '    if (rejected >= 0) { /* MUTANT */\n      const kept = `${basename(this.poolOutPath)}.unread`;',
    why: 'Every start writes a copy and says a file could not be read.',
  },
  {
    id: 'PO-K-xii. ★★★ a return notice is served while a new alarm stands',
    file: SN, tests: [T_STORE],
    find: '      if (!st || st.episode != null) return null;',
    to: '      if (!st) return null; /* MUTANT */',
    why: '"Core back in the backup pool" beside a standing "Core out".',
  },
  {
    id: 'PO-K-xiii. ★★ the boot sweep is handed another episode\'s end',
    file: SN, tests: [T_STORE],
    find: '      if (end && notBeforeMs != null && end.atMs < notBeforeMs) return null;',
    to: '      /* MUTANT */',
    why: 'An end record from before the push being resolved words that resolve.',
  },
  {
    id: 'PO-K-xiv. ★★★ the store tells the tracker every panel is online',
    file: SN, tests: [T_STORE],
    find: 'online: cur.online === true, witness, latched, diag, grid',
    to: 'online: true, witness, latched, diag, grid /* MUTANT */',
    why: 'Bodies of a panel the cloud lists offline are counted as observations.',
  },
  {
    id: 'PO-K-xv. ★★★ a failed save leaves the old state file in place',
    file: SN, tests: [T_STORE],
    find: "        unlinkSync(path);\n        removed = 'the file is removed, so a restart starts every panel with no reference and no alarm';",
    to: "        void path; /* MUTANT */\n        removed = 'the file is removed, so a restart starts every panel with no reference and no alarm';",
    why: 'A restart restores an alarm that ended after the last save that worked.',
  },
  {
    id: 'PO-K-xvi. ★★★ captures are pruned oldest first',
    file: SN, tests: [T_STORE],
    find: '      const drop = poolEventsToDrop(names);',
    to: '      const drop = [...names].sort().slice(0, Math.max(0, names.length - 20)); /* MUTANT */',
    why: 'A run of streak starts pushes the capture of a raise out of the files kept.',
  },

  /* (M) the monitor and the voice */
  {
    id: 'PO-M-i. ★★★ a push that failed is not tried again',
    file: AM, tests: [T_MONITOR, T_ALERT],
    find: '        alreadyQueued: existing.queued === true && a.pushInQuietHours !== true,',
    to: '        alreadyQueued: existing.queued === true, /* MUTANT */',
    why: 'Home Assistant unreachable for one send at 23:46: the alarm arrives at 07:00 as a title line.',
  },
  {
    id: 'PO-M-ii. ★★★ the push debounce delays this alarm',
    file: AM, tests: [T_BOOT, T_ALERT],
    find: "      const debounceMs = a.severity === 'critical' || a.pushInQuietHours === true ? 0 : notifyDebounceMsFor(a);",
    to: "      const debounceMs = a.severity === 'critical' ? 0 : notifyDebounceMsFor(a); /* MUTANT */",
    why: '"At once" is sixty to a hundred seconds after the raise.',
  },
  {
    id: 'PO-M-iii. ★★★ the boot sweep sends its own text for this alarm',
    file: AM, tests: [T_MONITOR],
    find: '        const returned = poolOutResolveText({ id, sourceSn: rec.sourceSn }, (sn) => store.poolOutEndNotice(sn, Date.now(), rec.ts));',
    to: '        const returned = null as { title: string; body: string } | null; /* MUTANT */',
    why: 'A restart while the return notice waits for the quiet hours: "cleared while the add-on was restarting".',
  },
  {
    id: 'PO-M-iv. ★★★ this alarm does not yield the spoken message',
    file: TS, tests: [T_ALERT],
    find: "const YIELDS_THE_VOICE = 'shp2-pool-out';",
    to: "const YIELDS_THE_VOICE = 'no-such-alert'; /* MUTANT */",
    why: 'A Core out for days outranks every Grid, Thermal and Connectivity critical: "Reserve alarm blind" is never named aloud.',
  },
  {
    id: 'PO-M-v. ★★ this alarm takes the spoken message from every other',
    file: TS, tests: [T_ALERT],
    find: '    if (yieldA !== yieldB) return yieldA - yieldB;',
    to: '    if (yieldA !== yieldB) return yieldB - yieldA; /* MUTANT */',
    why: 'The clause turned round.',
  },

  /* the three lines of index.ts */
  {
    id: 'PO-X-xlix. ★★ the debug route is not registered',
    file: IX, tests: [T_STORE],
    find: "app.get('/api/debug/pool-out', async () => store.poolOutDebug(Date.now()));",
    to: '/* MUTANT */',
    why: 'The tracker\'s state cannot be read from a running add-on.',
  },
  {
    id: 'PO-X-l. ★★★ /api/ha-state does not carry the field',
    file: IX, tests: [T_HA],
    find: '    ...poolCoreOutStateFields(store.poolOutSensorStatesSafe(Date.now())),',
    to: '    /* MUTANT */',
    why: 'The two Home Assistant builders publish different states.',
  },
  {
    id: 'PO-X-li. ★★★ production builds its store with no pool-out state file',
    file: IX, tests: [T_PATH],
    find: 'const store = new SnapshotStore();',
    to: 'const store = new SnapshotStore({ poolOutPath: null }); /* MUTANT */',
    why: 'Nothing is saved: every restart forgets a standing alarm.',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs).
import { runMutantsParallel } from './lib/mutateParallel.mjs';
await runMutantsParallel({ name: 'mutate-pool-out', mutants: MUTANTS, subset: [], root: REPO, perMutantTests: true, typecheck: true, fullSuite: false });
