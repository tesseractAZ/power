#!/usr/bin/env node
/**
 * mutate-v1188-1.mjs — v1.188.1: the recorder writes only FRESH readings; held rows already written
 * are moved out of `samples` (kept, restorable); the night-charge ledger does not score on held
 * telemetry. After the 2026-10-14 internet outage every Core stayed offline in the EcoFlow cloud for
 * ~20 h and the 5-minute heartbeat restated each one's last reading as new: ~1,300 rows per Core
 * per hour, PV 0 W through a solar day.
 *
 *   G-i     the gate is dropped from extract() (the incident's held heartbeats return)
 *   G-ii    the window boundary becomes `>=` (exactly the window is refused)
 *   G-iii   Math.abs is dropped (a content clock stepped ahead is a reading)
 *   G-iv    a missing content clock is a reading (fail-open)
 *   G-v     the cloud-shadow clause is dropped (a replayed panel body is written)
 *   G-vi    the gate keys on lastUpdated (a /status flip vouches for a held projection)
 *   G-vii   the gate keys on `online` (a Core streaming MQTT while listed offline is dropped)
 *   G-viii  the window becomes the 5-minute heartbeat (a held device gets one restatement)
 *   G-ix    heldSinceMs ignores the shadow onset
 *   G-x     the gate ignores a Core's content clock (a REST 200 replaying a Core's cached body is written)
 *   G-xi    heldSinceMs ignores a Core's content clock (a replay's held span restarts with every 200)
 *
 * Fix round 3 (review):
 *   G-xii   a panel counter with no row in a window does not hold its watermark (a window inside a
 *           panel shadow or a quota stall is lost from Panel Load, Grid Import (Home), the circuits)
 *   G-xiii  the hold is applied to the counters the energy bridge adds to (its share for the window is dropped)
 *   R-i     the restart probe's graceful test is two-sided again (a deploy in a hold reads as power)
 *   R-ii    the restart probe never reads the marker
 *   S-i     a gate span is logged however short
 *   S-ii    a hold is never closed when the device reports again
 *   S-iii   the seeded gap clock is not moved back after a move
 *   F-i     the scanner needs no restatements
 *   F-ii    the scanner needs no metric count (a 7-metric device's idle hour is moved)
 *   F-iii   a metric's first row is not new content
 *   F-iv    the scanner's minimum length is dropped (a 40-min stretch is moved)
 *   F-v     a known span's tail must qualify on its own (the deploy's last 15 min stay)
 *   F-vi    every stretch is moved, qualifying or not
 *   M-i     the move copies but does not delete (held rows stay in samples)
 *   M-ii    the move deletes but does not copy (DESTRUCTIVE)
 *   M-iii   rows younger than 15 min are moved (the rollup's pending window shrinks)
 *   M-iv    a restored span is moved again
 *   M-v     synthetic series and bench spares are scanned
 *   M-vi    the scan is never scheduled in the add-on
 *   M-vii   a scanning process reports ready before its first scan
 *   L-i     an hour of hold inside the span is not refused (`>` for `>=`)
 *   L-ii    the panel's hold is ignored (the load actual is integrated from held readings)
 *   L-iii   the repair ignores the marker (a re-captured row is reset forever)
 *   L-iv    the repair reads the full 24 h, not the span the row was captured over
 *   L-v     the repair re-captures past the horizon
 *   W-i     the scorer integrates PV over a held Core
 *   W-ii    the scorer integrates load over a held panel
 *   W-iii   the held reason is not stated (falls through to the coverage reasons)
 *   W-iv    the sweep does not wait for the first scan
 *   W-v     the sweep does not repair before it captures
 *
 * Fix round 1 (review):
 *   D-i     the in-process sweep measures now − last again (a fleet outage files every device)
 *   D-ii    inProcessDeviceDarkMs ignores the fleet-dark windows
 *   D-iii   the silence the batch is ending is not counted (filed before the fleet record exists)
 *   N-i     the incomplete-basis note drops the held verdict (no marker)
 *   N-ii    the scorer writes the bare basis note on a held row
 *   O-i     a gap with no rows counts toward a frozen stretch's length
 *   O-ii    an interval of exactly the bridge is not observed constancy
 *   O-iii   observed constancy carries over from the previous stretch
 *   K-i     the watermark is saved past a failed slice
 *   K-ii    a failed slice is not remembered
 *   K-iii   a failure is remembered by every later scan (the watermark never advances again)
 *   P-i     a move does not advance the samples generation
 *   P-ii    a restore does not advance the samples generation
 *   P-iii   the chokepoint resets the result caches only, not the closed-day memos
 *   P-iv    buildReport never reads the samples generation
 *   P-v     the closed-day energy memo survives a move
 *   P-vi    the equipment-health series survives a move
 *   C-i     a curtailment hour with no panel_load is 0 W of load again
 *   T-i     a series is carried across its own gap
 *   T-ii    a series is carried without bound after its newest point
 *   T-iii   no break row inside a gap (a one-series chart runs straight across)
 *   T-iv    the trend chart connects nulls again
 *   T-v     the trend chart ignores its bucket in the gap
 *
 * Dry-run follow-ups (a run of the real scan over a copy of the live database):
 *   Y-i     a later, overlapping record of the device is not extended (a second record at the restart)
 *   Y-ii    the move does not re-date the record it filed from a held row
 *   Y-iii   a re-dated record's alert id follows its new start (a second push)
 *   Y-iv    the alert is keyed on the record's current start
 *   Y-v     the overlapping record is extended but keeps its later start
 *   Y-vi    the overlap match accepts an earlier record (a second blackout extends the first)
 *   Y-vii   the re-date ignores the moved slice's end (an older span re-dates a current record)
 *   Z-i     the held spans are read once per stretch again
 *   Z-ii    the scanner keeps every non-qualifying stretch
 *   Z-iii   a return piece joins the hold before it has qualified on its own (the August return row is moved)
 *   Z-iv    a span's tail is extended across any silence
 *   Z-v     a gap of exactly an hour is a silence, not a hole
 *   Z-vi    a span an earlier scan moved is extended as a new one (announced again)
 *   Z-vii   the first scan starts at the retention horizon again
 *   X-i     the held-flow estimate is the stretch's length again
 *   X-ii    the tag note says the actuals were integrated from held readings
 *   X-iii   the reset names an actual that was captured empty
 *   X-iv    the reset names a side that was not held
 *   X-v     the sweep does not hand the reset the row as captured
 *   X-vi    several dark devices each read "one device went dark"
 *   X-vii   the dark-device count is not by overlap
 *   X-viii  a fleet silence the gate explains blames a broker stall again
 *   X-ix    the recorder does not keep what the gate held
 *   X-x     what the gate held is never cleared by a recordable home reading
 *   X-xi    an evaluation with a recordable home reading adds its held devices
 *
 * Review round 2 (holes, silences, cadence; restores; what explains a silence):
 *   V-i     the return gap is the bridge again (a restart's hole leaves a hold's tail in samples)
 *   V-ii    a stretch too short to be a hold is joined across a silence (cadence decides)
 *   V-iii   a return reading does not become the anchor (cadence decides)
 *   V-iv    the tail of a moved span is measured from the fresh reading
 *   V-v     the held-flow estimate counts the whole stretch, not the range moved
 *   V-vi    an extension of a span states nothing
 *   V-vii   the announcement states the stretch's end, not the move's
 *   V-viii  no observed run is recorded (every estimate 0.0 kWh)
 *   V-ix    a joined return piece's observed runs are dropped
 *   V-x     a joined return piece's observed time is dropped (the incident never qualifies)
 *   Q-i     a restore leaves the gap record re-dated (a second record, the same id)
 *   Q-ii    a boot after a restore by SQL does not match the start the record was filed with
 *   Q-iii   the matched record keeps its re-dated start
 *   Q-iv    a restore does not put the seeded clock back
 *   Q-v     the move does not remember the seed it set back
 *   E-i     held evaluations explain a silence however far apart they were
 *   E-ii    the end of the silence is not checked
 *   E-iii   a stall inside the silence is not seen
 *   E-iv    a held device's shadow flag is its last one
 *   E-v     bench spares are named in what the gate held
 *   E-vi    the post-boot silence never carries what the gate held
 *
 * Review round 3 (a span's start; the gap clocks; what the alerts and notes state):
 *   A-i     a re-read opens a return piece after a kept anchor's moved span (its tail stays for good)
 *   A-ii    a re-dated record is logged at its "last fresh reading" again (a kept restated row)
 *   A-iii   the move sets back only a seeded gap clock (an in-process replay is filed a hold late)
 *   A-iv    a restore puts back only a seeded gap clock
 *   A-v     a restore of any span forgets the clock the move set back
 *   A-vi    the move re-dates a record only when it set a clock back
 *   A-vii   a gate span is read as a moved frozen span (fresh return readings are moved)
 *   A-viii  a return piece that joins on its last row leaves the stretch's end behind
 *   A-ix    a return piece that joins on its last row adds none of its rows
 *   A-x     the first scan starts at the last listed metric's oldest row
 *   A-xi    the stall measure is not reset between silences
 *   A-xii   what the gate held is not cleared between silences
 *   A-xiii  the devices read with nothing measurable are not cleared between silences
 *   A-xiv   a bench spare's fresh rows end a held silence
 *   A-xv    the recorder does not keep the devices read with nothing measurable
 *   A-xvi   a device held in the silence is also named as read with nothing measurable
 *   A-xvii  the alert ignores the devices read with nothing measurable
 *   A-xviii the phrase says every home device was held whatever was read
 *   A-xix   the dark-device count is by overlap with the window again, not at one instant
 *   A-xx    the reset note ignores whether a held row lay inside the span
 *   A-xxi   the sweep does not look the held rows up
 *   A-xxii  heldRowsWithin finds a held row everywhere
 *   A-xxiii the documented SQL restore drops the samples-generation step
 *
 * Review round 4 (a restore gives back the hold; a replayed Core's gap clock; a record inside its window):
 *   B-i     a restored span is matched on overlap alone (the rest of a running hold is moved again)
 *   B-ii    the restored span's end does not follow its hold
 *   B-iii   the scanner does not keep a stretch anchored in a restored span (a sparse continuation)
 *   B-iv    the continuation of a restored span is logged by every scan
 *   B-v     a seed inside a device record's window is matched only on a re-dated record's filed start
 *   B-vi    the record matched inside its window takes the seed's start
 *   B-vii   the gap line states the seed's start, not the record's window
 *   B-viii  the move sets a clock back only within the moved rows (a running replay is never filed)
 *   B-ix    the scan does not say where the stretch's restatements end
 *   B-x     a restated write of a held Core resets its clock (re-arms the sweep)
 *   B-xi    a write after more than an hour without one stays held (a return)
 *   B-xii   a changed write does not end the hold
 *   B-xiii  a restore does not end the hold
 *   B-xiv   a restore of a running replay leaves the clock at the span's start
 *   B-xv    a moved span's tail is re-anchored at its own last row across a silence (survivor S2-10)
 *   B-xvi   a return piece that never qualified carries across a fresh change (survivor S2-3)
 *   B-xvii  a joined return piece's values are dropped (survivor HS-3)
 *   B-xviii a flow held at 0 W is stated as integrated energy (survivor R3-4)
 *   B-xix   the load side ignores whether a held row lay inside the span (survivor NL-1)
 *   B-xx    the load side is never described as integrated over hours with no readings (survivor NL-2)
 *   B-xxi   the repair hands back the 24 h span, not the span as captured (survivor NL-5)
 *   B-xxii  a device listed with no projection is named as read with nothing measurable (survivor RC-5)
 *   B-xxiii the re-date has no lower bound (an older record is found first: survivor RC-8)
 *   B-xxiv  a record re-dated twice takes its second start as its id (survivor RC-4)
 *   B-xxv   a restore sets back a clock the device has written since (survivor RC-2)
 *   B-xxvi  a record that begins as another ends is dark at the same time (survivor D2-1)
 *
 * Review round 5 (a restore by SQL; the plan-to-move window and the restart; the upgrade push; one
 * record per darkness; the ledger per side):
 *   H-i     the sweep never looks a restored span up (a SQL restore leaves the Core held: a false push)
 *   H-ii    the restored-span lookup finds nothing
 *   H-iii   the lookup reads any frozen span, restored or not (every running replay released)
 *   H-iv    the sweep skips a restored span's device without releasing it (never filed again)
 *   H-v     a seeded record does not wait for the first scan (the upgrade push states a held row)
 *   H-vi    the wait ignores whether the scan runs here (never filed outside the add-on)
 *   H-vii   the move holds a clock only up to the rows the scan read (a heartbeat after the plan)
 *   H-viii  a value that changed and changed back after the plan is a restatement
 *   H-ix    a first write after the plan is not compared with its held value
 *   H-x     a write after the plan more than an hour after the last restated row is still the hold
 *   H-xi    a first write after a restart is compared with nothing (the hold ends at the boot scan)
 *   H-xii   … with its own value (a changed first write stays held)
 *   H-xiii  … with no hole bound (a return after a silence stays held)
 *   H-xiv   the hold remembers the moved end, not the last restated row
 *   H-xv    the re-date merges nothing (two records, one darkness)
 *   H-xvi   the merge reaches a record before the span
 *   H-xvii  the merge reaches a record of a later darkness
 *   H-xviii the merge drops the re-dated record too
 *   H-xix   the move keeps a clock remembered by an earlier move (round-4 survivor)
 *   H-xx    a record extended from a seed inside its window states the seed's duration
 *   H-xxi   the move hands the recorder no held values
 *   H-xxii  heldSides reads PV from the load side
 *   H-xxiii heldSides holds PV whenever anything is held
 *   H-xxiv  the scorer withholds PV on the load side
 *   H-xxv   the scorer withholds load on the PV side
 *   H-xxvi  the repair reads the marker per row again (a side found after the capture is never repaired)
 *   H-xxvii a side whose span was restored is never repaired (refused for good)
 *   H-xxviii a restored side past the horizon is tagged (a crash, or a tag on every sweep)
 *   H-xxix  heldSidesNoted reads only the first held clause
 *   H-xxx   heldSidesNoted never reads a load part
 *   H-xxxi  the tag drops the notes as captured (survivor N13)
 *   H-xxxii the tag names every held side, not the one found
 *   H-xxxiii the reset clause describes every held side, not the one found
 *   H-xxxiv a degenerate stored window is a window (survivor N5)
 *   H-xxxv  the repair reads two days of spans (survivor N14)
 *   H-xxxvi the repair returns when no span is left (a restore of every span is never repaired)
 *   H-xxxvii the repair writes nothing (survivor N12)
 *   H-xxxviii the restore line does not say where the hold it gives back ends
 *   H-xxxix a side no longer held counts as restored without a restored span (a roster change resets rows)
 *   H-xl    restoredSpans lists every frozen span, restored or not
 *   H-xli   the repair is handed no restored spans
 *
 * Review round 6 (a restore while a scan runs; a seeded clock past the stretch; a Core back during
 * the first scan; a restore after a restart; a restored replay past its record; a fleet-wide replay;
 * the ledger's restored side):
 *   J-i     a restore since the scan was planned is not looked for at the move
 *   J-ii    a stretch left for its restore at the move is counted as a held stretch
 *   J-iii   a seeded clock past the stretch is held whenever it lies within an hour of its end
 *   J-iv    a seeded device's first write during the first scan is not remembered
 *   J-v     a remembered return is judged before the first scan has finished
 *   J-vi    a remembered return keeps the held row it was seeded with
 *   J-vii   every remembered return is filed, however short its darkness
 *   J-viii  a remembered return's record runs to when it was judged, not to the return
 *   J-ix    the sweep looks a restored span up only for a device held from it in this process
 *   J-x     the sweep releases a restored span's device even when its clock cannot move (survivor R3)
 *   J-xi    a restore in a process booted after the move leaves the clock at the span's start
 *   J-xii   the clock a restore gives back is one series' newest row, not the device's
 *   J-xiii  a seed inside a restored span from a record's start does not match the record
 *   J-xiv   a held restatement is a home insert
 *   J-xv    the fleet clock is not set back when every home device is held
 *   J-xvi   the fleet clock is set back past this process's first home write
 *   J-xvii  a restore of one Core does not move the fleet clock forward
 *   J-xviii an evaluation that only restated a hold resets the silence
 *   J-xix   the replayed devices are not kept for what explains the silence
 *   J-xx    with no device held by the gate, the replayed ones explain nothing
 *   J-xxi   a replayed Core is named as read with nothing measurable
 *   J-xxii  the gap line does not say a device restated readings the scan moved
 *   J-xxiii the alert leaves out a replayed Core
 *   J-xxiv  a replayed Core is also phrased as sending no new readings
 *   J-xxv   the alert says nothing was recorded when replayed rows were
 *   J-xxvi  the restored side ignores what is still held (survivor L1)
 *   J-xxvii the PV side is matched against the panel's restored span too (survivor L2)
 *   J-xxviii a restored span counts only when it lies inside the row's span (survivor L3)
 *   J-xxix  a restored span counts only when it starts inside the row's span (survivor L4)
 *   J-xxx   the repair does not say it reset a row (survivor I1)
 *   J-xxxi  a write lock held elsewhere fails the whole scan, not the slice
 *
 *   node scripts/mutate-v1188-1.mjs
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HS = resolve(REPO, 'server/src/heldSamples.ts');
const REC = resolve(REPO, 'server/src/recorder.ts');
const NLS = resolve(REPO, 'server/src/nightLedgerScoring.ts');
const IDX = resolve(REPO, 'server/src/index.ts');
const AN = resolve(REPO, 'server/src/analytics.ts');
const REP = resolve(REPO, 'server/src/reports.ts');
const TM = resolve(REPO, 'web/src/charts/trendMerge.ts');
const TC = resolve(REPO, 'web/src/charts/TrendChart.tsx');
const AL = resolve(REPO, 'server/src/alerts.ts');
const ARCH = resolve(REPO, 'docs/reference/01-architecture.md');
const SUBSET = [
  'test/recorderHeldReadings.test.ts',
  'test/heldSamplesBackfill.test.ts',
  'test/ledgerHeldTelemetry.test.ts',
  'test/recorderRestartGap.test.ts',
  'test/heldSamplesWorkerMemo.test.ts',
  'test/curtailmentHeldPanel.test.ts',
  'test/trendMergeGaps.test.ts',
  'test/panelGapLifetime.test.ts',
  'test/energyBridgeSeams.test.ts',
  'test/heldSamplesDryRun.test.ts',
  'test/deviceGapAlerts.test.ts',
  'test/heldSamplesHoles.test.ts',
  'test/heldGapRecords.test.ts',
  'test/heldSamplesAnchors.test.ts',
  'test/heldSamplesReview4.test.ts',
];

const MUTANTS = [
  {
    id: 'G-i. ★★★ the gate is dropped from extract()',
    file: REC,
    find: '      if (!projectionRecordable(d, nowMs)) {',
    to: '      if (false) { /* MUTANT */',
    why: 'A Core the cloud lists offline has its last reading restated every 5 minutes as new telemetry: the 2026-10-14 incident.',
  },
  {
    id: 'G-ii. ★ the window boundary becomes >=',
    file: HS,
    find: '  if (Math.abs(nowMs - t) > freshMs) return false;',
    to: '  if (Math.abs(nowMs - t) >= freshMs) return false; /* MUTANT */',
    why: 'Content exactly RECORD_FRESH_MS old is refused.',
  },
  {
    id: 'G-iii. ★★ Math.abs is dropped',
    file: HS,
    find: '  if (Math.abs(nowMs - t) > freshMs) return false;',
    to: '  if (nowMs - t > freshMs) return false; /* MUTANT */',
    why: 'A content clock stepped ahead (an NTP step on an RTC-less Pi) keeps a frozen projection recordable for as long as the step.',
  },
  {
    id: 'G-iv. ★★ a missing content clock is a reading',
    file: HS,
    find: "  if (typeof t !== 'number' || !Number.isFinite(t) || t <= 0) return false;",
    to: "  if (typeof t !== 'number' || !Number.isFinite(t) || t <= 0) return true; /* MUTANT */",
    why: 'Fail-open: a projection no writer stamped is restated forever.',
  },
  {
    id: 'G-v. ★★ the cloud-shadow clause is dropped',
    file: HS,
    find: "  if (d.contentStaleSinceMs != null) return false;\n  return d.projection?.kind !== 'dpu' || dpuContentFresh(d, nowMs);",
    to: "  return d.projection?.kind !== 'dpu' || dpuContentFresh(d, nowMs); /* MUTANT */",
    why: 'A panel body the cloud replays (every REST 200 bumps lastTelemetryAtMs) is written as fresh readings.',
  },
  {
    id: 'G-vi. ★★ the gate keys on lastUpdated',
    file: HS,
    find: '  const t = d.lastTelemetryAtMs;\n  if (typeof t',
    to: '  const t = (d as { lastUpdated?: number }).lastUpdated; /* MUTANT */\n  if (typeof t',
    why: 'A bare /status flip, which carries no content, makes a held projection a reading again.',
  },
  {
    id: 'G-vii. ★★ the gate keys on online',
    file: REC,
    find: '      if (!projectionRecordable(d, nowMs)) {',
    to: '      if (!d.online) { /* MUTANT */',
    why: 'A Core streaming MQTT while the cloud list says offline loses genuine readings; a device absent from the list keeps its last online value and is restated.',
  },
  {
    id: 'G-viii. ★ the window becomes the 5-minute heartbeat',
    file: HS,
    find: 'export const RECORD_FRESH_MS = 3 * MIN_MS;',
    to: 'export const RECORD_FRESH_MS = 5 * MIN_MS; /* MUTANT */',
    why: 'A device that stops reporting gets one restated heartbeat before the gate closes.',
  },
  {
    id: 'G-ix. heldSinceMs ignores the shadow onset',
    file: HS,
    find: '  return c.length === 0 ? null : Math.min(...c);',
    to: '  return c.length === 0 ? null : c[c.length - 1]; /* MUTANT */',
    why: 'A replayed panel body is logged as held only from the last replay, not from when its content stopped moving.',
  },
  {
    id: 'R-i. ★★ the restart probe\'s graceful test is two-sided again',
    file: REC,
    find: '  return markerTs != null && maxTs != null && markerTs >= maxTs - MAX_INTERVAL_MS;',
    to: '  return markerTs != null && maxTs != null && Math.abs(markerTs - maxTs) <= MAX_INTERVAL_MS; /* MUTANT */',
    why: 'With the gate, a deploy made while every home device is offline in the cloud is ledgered as "the Pi lost power" and counted as a power outage.',
  },
  {
    id: 'R-ii. the restart probe never reads the marker',
    file: REC,
    find: '    const graceful = cleanShutdownWasGraceful(markerTs, maxTs);',
    to: '    const graceful = false && cleanShutdownWasGraceful(markerTs, maxTs); /* MUTANT */',
    why: 'Every deliberate restart reads as a power loss.',
  },
  {
    id: 'S-i. a gate span is logged however short',
    file: HS,
    find: '      if (g.endMs - g.startMs >= HELD_SPAN_MIN_MS && atMs - g.persistedAtMs >= HELD_GATE_PERSIST_EVERY_MS) persistGate(sn, g, atMs);',
    to: '      if (atMs - g.persistedAtMs >= HELD_GATE_PERSIST_EVERY_MS) persistGate(sn, g, atMs); /* MUTANT */',
    why: 'Every missed poll becomes a held span, and the ledger refuses nights for minutes the trapezoid bridges.',
  },
  {
    id: 'S-ii. a hold is never closed when the device reports again',
    file: HS,
    find: '      if (held.has(sn)) continue;\n      if (g.persistedAtMs > 0) {',
    to: '      if (true) continue; /* MUTANT */\n      if (g.persistedAtMs > 0) {',
    why: 'A device that came back keeps an open span, and nothing records that its readings resumed.',
  },
  {
    id: 'S-iii. ★★ the gap clock is not moved back after a move',
    file: REC,
    find: '      if (clock != null && clock > startMs && (clock <= through || (!seededNotYetWritten.has(sn) && restatedSince(sn, through, heldValues)))) {',
    to: '      if (clock != null && clock > startMs && (clock <= through || (!seededNotYetWritten.has(sn) && restatedSince(sn, through, heldValues))) && Date.now() < 0) { /* MUTANT */',
    why: 'A Core still held at the deploy is measured from a held row that no longer exists: its gap is filed 6 h late, from the wrong start, and a later boot files a second record.',
  },
  {
    id: 'F-i. ★ the scanner needs no restatements',
    file: HS,
    find: '  const qualifies = (a: StretchAcc) => a.observedMs >= opts.minSpanMs && restatementsOf(a) >= opts.minRestatements && a.counts.size >= opts.minMetrics;',
    to: '  const qualifies = (a: StretchAcc) => a.observedMs >= opts.minSpanMs && a.counts.size >= opts.minMetrics; /* MUTANT */',
    why: 'Two identical rows an hour apart — a restart after an hour down — read as a hold.',
  },
  {
    id: 'F-ii. ★★ the scanner needs no metric count',
    file: HS,
    find: '  const qualifies = (a: StretchAcc) => a.observedMs >= opts.minSpanMs && restatementsOf(a) >= opts.minRestatements && a.counts.size >= opts.minMetrics;',
    to: '  const qualifies = (a: StretchAcc) => a.observedMs >= opts.minSpanMs && restatementsOf(a) >= opts.minRestatements; /* MUTANT */',
    why: 'A generic device that legitimately sat idle for an hour has its real rows moved.',
  },
  {
    id: 'F-iii. a metric\'s first row is not new content',
    file: HS,
    find: '          if (pv === undefined || pv !== rows[j].value) changed = true;',
    to: '          if (pv !== undefined && pv !== rows[j].value) changed = true; /* MUTANT */',
    why: 'A scan from the start of the data has no fresh anchor and never finds the first stretch.',
  },
  {
    id: 'F-iv. ★★ the scanner\'s minimum length is dropped',
    file: HS,
    find: '  const qualifies = (a: StretchAcc) => a.observedMs >= opts.minSpanMs && restatementsOf(a) >= opts.minRestatements && a.counts.size >= opts.minMetrics;',
    to: '  const qualifies = (a: StretchAcc) => restatementsOf(a) >= opts.minRestatements && a.counts.size >= opts.minMetrics; /* MUTANT */',
    why: 'Forty quiet minutes of a live Core are moved out of samples.',
  },
  {
    id: 'F-v. ★★ a known span\'s tail must qualify on its own',
    file: HS,
    find: '        keepUnqualified: (startMs) => frozenEnds.has(startMs) || restored.some((r) => anchoredIn(r, startMs)),',
    to: '        keepUnqualified: () => false, /* MUTANT */',
    why: 'The newest 15 min of a hold, left by the first scan after the deploy, restate each metric only once or twice: they stay in samples, and the held Core\'s gap clock stays on a held row.',
  },
  {
    id: 'F-vi. ★★ every stretch is moved, qualifying or not',
    file: HS,
    find: '      if (q || keep(anchor, cur.firstHeldTs)) {',
    to: '      if (true) { /* MUTANT */',
    why: 'Any two identical rows — a quiet live Core between two changes — are moved out of samples.',
  },
  {
    id: 'M-i. ★★★ the move copies but does not delete',
    file: HS,
    find: '      const deleted = Number(moveDeleteStmt.run(job.fromMs, job.toMs, job.sn).changes);',
    to: '      const deleted = copied; /* MUTANT */',
    why: 'The held rows stay in samples, so every learner and scorer keeps reading them as measurements.',
  },
  {
    id: 'M-ii. ★★★ the move deletes but does not copy (DESTRUCTIVE)',
    file: HS,
    find: '      const copied = Number(moveCopyStmt.run(job.fromMs, job.toMs, job.sn).changes);',
    to: '      const copied = Number(moveDeleteStmt.run(job.fromMs, job.toMs, job.sn).changes); /* MUTANT */',
    why: 'The owner\'s rows are deleted: nothing to restore.',
  },
  {
    id: 'M-iii. ★ rows younger than 15 min are moved',
    file: HS,
    find: '      const end = Math.min(s.endMs, moveUntil);',
    to: '      const end = s.endMs; /* MUTANT */',
    why: 'The lifetime rollup re-reads its last 10 min every 5 min: a counter would see its pending window shrink and step down.',
  },
  {
    id: 'M-iv. ★★ a restored span is moved again',
    file: HS,
    find: '      const r = job.restored.find((x) => continuesRestored(x, s));',
    to: '      const r = undefined as { startMs: number; endMs: number } | undefined; /* MUTANT */',
    why: 'A restore is undone by the next hourly scan: the exclusion is not reversible.',
  },
  {
    id: 'M-v. synthetic series and bench spares are scanned',
    file: REC,
    find: '    isExcludedSn: (sn) => SYNTHETIC_SNS.has(sn) || isBenchSpareSn(sn),',
    to: '    isExcludedSn: () => false, /* MUTANT */',
    why: 'The weather series (a flat night of 0 W/m2) and an idle bench spare have their real rows moved.',
  },
  {
    id: 'M-vi. ★★ the scan is never scheduled in the add-on',
    file: REC,
    find: "  const heldScanFirst = heldScanScheduled ? setTimeout(() => heldStore.scanInSteps(), 60_000) : null;",
    to: "  const heldScanFirst = null as ReturnType<typeof setTimeout> | null; /* MUTANT */",
    why: 'The rows the incident wrote are never moved: every learner keeps reading them.',
  },
  {
    id: 'M-vii. ★★ a scanning process reports ready before its first scan',
    file: REC,
    find: '    heldSamplesReady: () => !heldScanScheduled || heldStore.isReady(),',
    to: '    heldSamplesReady: () => true, /* MUTANT */',
    why: 'The ledger captures a row in the first minute after the deploy, on the held rows the scan is about to move.',
  },
  {
    id: 'L-i. ★ an hour of hold inside the span is not refused',
    file: NLS,
    find: '    if (heldMs >= min) pv.push({ sn, heldMs });',
    to: '    if (heldMs > min) pv.push({ sn, heldMs }); /* MUTANT */',
    why: 'The boundary moves off the trapezoid\'s own one-hour bridge.',
  },
  {
    id: 'L-ii. ★★ the panel\'s hold is ignored',
    file: NLS,
    find: '  if (panelHeld >= min) load.push({ sn: i.panelSn, heldMs: panelHeld });',
    to: '  void panelHeld; /* MUTANT */',
    why: 'The load actual is integrated over a held panel (01:55 → 04:16 on 2026-10-15) and graded.',
  },
  {
    id: 'L-iii. ★★ the repair ignores the marker',
    file: NLS,
    find: '  const noted = heldSidesNoted(row.score_notes);',
    to: '  const noted = { pv: false, load: false }; /* MUTANT */',
    why: 'A re-captured row is reset again on every sweep: it never stays captured.',
  },
  {
    id: 'L-iv. the repair reads the full 24 h, not the span the row was captured over',
    file: NLS,
    find: '  const span = { startMs: issued, endMs: Math.min(cap, issued + FORECAST_SPAN_MS) };',
    to: '  const span = { startMs: issued, endMs: issued + FORECAST_SPAN_MS }; /* MUTANT */',
    why: 'A row is reset for a hold that began after its actuals were integrated.',
  },
  {
    id: 'L-v. ★ the repair re-captures past the horizon',
    file: NLS,
    find: '  const inside = i.nowMs - issued <= i.horizonMs && forecastSpanRecapturable(row);',
    to: '  const inside = true; /* MUTANT */',
    why: 'A row whose telemetry has aged out is reset and re-captured on nothing, or on another fleet.',
  },
  {
    id: 'W-i. ★★★ the scorer integrates PV over a held Core',
    file: IDX,
    find: '    actualPvKwh = worstCov >= PV_LEDGER_MIN_CORE_COVERAGE && !pvHeld ? round2(pvWh / 1000) : null;',
    to: '    actualPvKwh = worstCov >= PV_LEDGER_MIN_CORE_COVERAGE ? round2(pvWh / 1000) : null; /* MUTANT */',
    why: 'An actual PV integrated around a held hour is written to the never-pruned ledger and graded.',
  },
  {
    id: 'W-ii. ★★ the scorer integrates load over a held panel',
    file: IDX,
    find: '  const actualLoadKwh = loadPts.length && !heldSide.load ? round2(integrateWh(loadPts, false) / 1000) : null;',
    to: '  const actualLoadKwh = loadPts.length ? round2(integrateWh(loadPts, false) / 1000) : null; /* MUTANT */',
    why: 'The load band calibration learns from a load the panel did not report.',
  },
  {
    id: 'W-iii. ★ the held reason is not stated',
    file: IDX,
    find: '  } else if (heldVerdict != null) {\n    scoreNotes = heldLedgerNote(heldVerdict, deviceNameOf);',
    to: '  } else if (false) { /* MUTANT */\n    scoreNotes = heldLedgerNote(heldVerdict!, deviceNameOf);',
    why: 'The row says "coverage" or "basis" instead of why — and the repair, missing the marker, resets it on every sweep.',
  },
  {
    id: 'W-iv. ★★ the sweep does not wait for the first scan',
    file: IDX,
    find: '  if (!(recorder.heldSamplesReady?.() ?? true)) {',
    to: '  if (false) { /* MUTANT */',
    why: 'A row due in the minute after the deploy is captured on the held rows the scan is about to move.',
  },
  {
    id: 'W-v. ★★ the sweep does not repair before it captures',
    file: IDX,
    find: '  if (repairHeldNightOutcomes(rows, shp2Sn, nowMs)) rows = recorder.readNightLedger(LEDGER_BACKFILL_SWEEP_DAYS);',
    to: '  /* MUTANT */',
    why: 'The 10-14 row captured on held PV (and the 10-15 row, if captured before the deploy) keep their fabricated verdicts.',
  },
  // ── fix round 1 (review) ──
  {
    id: 'D-i. ★★★ the in-process sweep measures now − last again',
    file: REC,
    find: '          : inProcessDeviceDarkMs(lastMs, now, fleetDark);',
    to: '          : now - lastMs; /* MUTANT */',
    why: 'After a 7 h internet outage every device but the first to answer is filed as dark for 7 h: three false pushed "Device telemetry gap" WARNINGs.',
  },
  {
    id: 'D-ii. ★★ inProcessDeviceDarkMs ignores the fleet-dark windows',
    file: REC,
    find: '  return Math.max(0, nowMs - lastMs - fleetDarkOverlapMs(fleetDarkWindows, lastMs, nowMs));',
    to: '  return Math.max(0, nowMs - lastMs); /* MUTANT */',
    why: 'A fleet-wide silence is charged to each device.',
  },
  {
    id: 'D-iii. ★★ the silence the batch is ending is not counted',
    file: REC,
    find: '        fleetDark.push({ startMs: lastHomeInsertTs, endMs: now });',
    to: '        /* MUTANT */',
    why: 'The fleet record is written after the sweep, so the first batch back files every other device for the whole outage.',
  },
  {
    id: 'N-i. ★★★ the incomplete-basis note drops the held verdict',
    file: NLS,
    find: '  if (v == null) return BASIS_INCOMPLETE_NOTE;',
    to: '  if (v == null || Date.now() > 0) return BASIS_INCOMPLETE_NOTE; /* MUTANT */',
    why: 'No marker: the held repair resets and re-captures the row on every sweep for 28 days.',
  },
  {
    id: 'N-ii. ★★ the scorer writes the bare basis note on a held row',
    file: IDX,
    find: '    scoreNotes = basisIncompleteNote(heldVerdict, deviceNameOf);',
    to: '    scoreNotes = basisIncompleteNote(null, deviceNameOf); /* MUTANT */',
    why: 'The same endless reset, from the scorer.',
  },
  {
    id: 'O-i. ★★★ a gap with no rows counts toward a frozen stretch',
    file: HS,
    find: '          if (prevRowTs != null && ts - prevRowTs <= bridgeMs) {',
    to: '          if (prevRowTs != null) { /* MUTANT */',
    why: 'A constant Core back from a 55-min gap has its fresh rows moved after 10 min of observation, and its night refused.',
  },
  {
    id: 'O-ii. an interval of exactly the bridge is not observed constancy',
    file: HS,
    find: '          if (prevRowTs != null && ts - prevRowTs <= bridgeMs) {',
    to: '          if (prevRowTs != null && ts - prevRowTs < bridgeMs) { /* MUTANT */',
    why: 'Rows two heartbeats apart (integrateWh\'s own bridge) read as a gap.',
  },
  {
    id: 'O-iii. ★ observed constancy carries over from the previous stretch',
    file: HS,
    find: '    cur = newStretchAcc();\n  };',
    to: '    cur = { ...newStretchAcc(), observedMs: cur.observedMs }; /* MUTANT */\n  };',
    why: 'Two short quiet stretches split by one change add up to an hour, and a live Core is moved.',
  },
  {
    id: 'K-i. ★★★ the watermark is saved past a failed slice',
    file: HS,
    find: '      scanStateUpsertStmt.run(Math.min(scanToMs, failedFromMs), scanFull ? now() : null);',
    to: '      scanStateUpsertStmt.run(scanToMs, scanFull ? now() : null); /* MUTANT */',
    why: 'An old span whose move failed is never read again: its held rows stay in samples for good.',
  },
  {
    id: 'K-ii. ★★ a failed slice is not remembered',
    file: HS,
    find: '      if (job.spanStartMs < failedFromMs) failedFromMs = job.spanStartMs;',
    to: '      /* MUTANT */',
    why: 'The same: the log promises a retry that never happens.',
  },
  {
    id: 'K-iii. a failure is remembered by every later scan',
    file: HS,
    find: '    scanCandidates = 0;\n    failedFromMs = Number.POSITIVE_INFINITY;',
    to: '    scanCandidates = 0;\n    /* MUTANT */',
    why: 'After one fault the watermark never advances again: every hourly scan re-reads days of rows.',
  },
  {
    id: 'P-i. ★★★ a move does not advance the samples generation',
    file: HS,
    find: '      if (moved > 0) bumpGenerationStmt.run();',
    to: '      /* MUTANT */',
    why: 'The worker keeps serving the closed day it memoised with the held flows until the next restart.',
  },
  {
    id: 'P-ii. ★ a restore does not advance the samples generation',
    file: HS,
    find: '      if (n > 0) bumpGenerationStmt.run();',
    to: '      /* MUTANT */',
    why: 'Restored rows stay invisible to the worker\'s memos.',
  },
  {
    id: 'P-iii. ★★ the chokepoint resets the result caches only',
    file: REP,
    find: '  advanceBasisGeneration();\n  resetWorkerSampleCaches();',
    to: '  advanceBasisGeneration();\n  resetWorkerReportCaches(); /* MUTANT */',
    why: 'The results are rebuilt on the same stale closed-day memo.',
  },
  {
    id: 'P-iv. ★★ buildReport never reads the samples generation',
    file: REP,
    find: '  noteSamplesGeneration(sgen, ctx.log);',
    to: '  void noteSamplesGeneration; /* MUTANT */',
    why: 'Nothing in the worker notices the move.',
  },
  {
    id: 'P-v. ★ the closed-day energy memo survives a move',
    file: AN,
    find: '  resetWorkerReportCaches();\n  dailyEnergyWhCache.clear();\n  eqSeriesCache.clear();',
    to: '  resetWorkerReportCaches();\n  /* MUTANT */\n  eqSeriesCache.clear();',
    why: 'The 7-day self-consumption and carbon KPIs keep the incident day\'s held flows.',
  },
  {
    id: 'P-vi. ★ the equipment-health series survives a move',
    file: AN,
    find: '  dailyEnergyWhCache.clear();\n  eqSeriesCache.clear();\n}',
    to: '  dailyEnergyWhCache.clear();\n  /* MUTANT */\n}',
    why: 'The inverter-standby idle-floor trend keeps the held ac_out buckets.',
  },
  {
    id: 'C-i. ★★ a curtailment hour with no panel_load is 0 W of load again',
    file: AN,
    find: "  const loadW = meanInWindow(shp2.sn, 'panel_load');\n  if (loadW == null) return null;",
    to: "  const loadW = meanInWindow(shp2.sn, 'panel_load') ?? 0; /* MUTANT */\n  if (loadW == null) return null;",
    why: 'An hour of a full pool and a held panel is counted as curtailed: the "PV exceeds load" disqualifier cannot fire on a missing load.',
  },
  {
    id: 'T-i. ★★★ a series is carried across its own gap',
    file: TM,
    find: '      const carried = next != null ? next.ts - at.ts <= gapMs : ts - at.ts <= gapMs;',
    to: '      const carried = next != null ? true : ts - at.ts <= gapMs; /* MUTANT */',
    why: 'A held Core is painted flat at its last reading while its sibling reports.',
  },
  {
    id: 'T-ii. ★★ a series is carried without bound after its newest point',
    file: TM,
    find: '      const carried = next != null ? next.ts - at.ts <= gapMs : ts - at.ts <= gapMs;',
    to: '      const carried = next != null ? next.ts - at.ts <= gapMs : true; /* MUTANT */',
    why: 'A Core still held is drawn flat to the right edge of the chart.',
  },
  {
    id: 'T-iii. ★ no break row inside a gap',
    file: TM,
    find: '      if (i + 1 < pts.length && pts[i + 1].ts - pts[i].ts > gapMs) all.add(pts[i].ts + 1);',
    to: '      /* MUTANT */',
    why: 'A one-device chart has no row inside the gap and runs one straight segment across it.',
  },
  {
    id: 'T-iv. ★ the trend chart connects nulls again',
    file: TC,
    find: '                isAnimationActive={false}\n              />',
    to: '                isAnimationActive={false}\n                connectNulls /* MUTANT */\n              />',
    why: 'The nulls the merge emits are drawn through: the gap is a line again.',
  },
  {
    id: 'T-v. the trend chart ignores its bucket in the gap',
    file: TC,
    find: 'dataBySeries, trendGapMs(bucketSec)),',
    to: 'dataBySeries, 10 * 60_000), /* MUTANT */',
    why: 'A chart bucketed coarser than 5 min breaks between every two buckets.',
  },
  {
    id: 'G-x. ★★★ the gate ignores a Core\'s content clock',
    file: HS,
    find: "  return d.projection?.kind !== 'dpu' || dpuContentFresh(d, nowMs);",
    to: '  return true; /* MUTANT */',
    why: 'The review defect: a Core whose cloud replays its cached body bumps lastTelemetryAtMs on every poll; its held PV and AC input are written as heartbeat rows and integrated into the lifetime counters for good.',
  },
  {
    id: 'G-xi. ★★ heldSinceMs ignores a Core\'s content clock',
    file: HS,
    find: "  if (d.projection?.kind === 'dpu' && ok(d.contentChangedAtMs)) c.push(d.contentChangedAtMs);",
    to: '  /* MUTANT */',
    why: 'A replaying Core\'s hold starts at its last arrival, which moves with every 200: the held span is never an hour long and is never logged.',
  },
  {
    id: 'G-xii. ★★★ a panel counter with no row in a window does not hold its watermark',
    file: REC,
    find: '      if (!bridgeShare && inWindow === 0 && now - lastBefore < LIFETIME_ROLLUP_LOOKBACK_MS) continue;',
    to: '      /* MUTANT */',
    why: 'The review defect: the gate writes no row while the panel is held, and every 5-min window inside a cloud shadow or a quota stall integrates to 0 Wh for good (292 Wh of load and 667 Wh of grid import in an 8 kW night-charge hour).',
  },
  {
    id: 'G-xiii. ★★ the hold is applied to the counters the energy bridge adds to',
    file: REC,
    find: '      if (!bridgeShare && inWindow === 0 && now - lastBefore < LIFETIME_ROLLUP_LOOKBACK_MS) continue;',
    to: '      if (inWindow === 0 && now - lastBefore < LIFETIME_ROLLUP_LOOKBACK_MS) continue; /* MUTANT */',
    why: 'PV Production and Grid to Battery Charge skip writing a window in which the bridge booked energy: the bridge\'s share is added only when the counter writes, so it is lost.',
  },
  // ── dry-run follow-ups ──
  {
    id: 'Y-i. ★★★ a later, overlapping record of the device is not extended',
    file: REC,
    find: '        ?? telemetryGapsLog.find((g) => g.sn === opts.sn && startMs < g.startMs && g.startMs <= endMs)',
    to: '        /* MUTANT */',
    why: 'The restart after the move files a second record for every Core still dark: a second pushed warning each, and Device Telemetry Gaps 24h doubles.',
  },
  {
    id: 'Y-ii. ★★ the move does not re-date the record it filed from a held row',
    file: REC,
    find: '      redateDeviceGap(sn, startMs, endMs);',
    to: '      /* MUTANT */',
    why: 'The digest states a start nothing measured (the last held row), until the next restart.',
  },
  {
    id: 'Y-iii. ★★★ a re-dated record\'s alert id follows its new start',
    file: REC,
    find: '    g.alertStartMs ??= g.startMs;',
    to: '    /* MUTANT */',
    why: 'The same blackout gets a new id: pushed again.',
  },
  {
    id: 'Y-iv. ★★ the alert is keyed on the record\'s current start',
    file: AL,
    find: '    id: deviceGapAlertId(sn, g.alertStartMs ?? g.startMs, g.durationMs),',
    to: '    id: deviceGapAlertId(sn, g.startMs, g.durationMs), /* MUTANT */',
    why: 'A re-dated record raises a new alert for a blackout already delivered.',
  },
  {
    id: 'Y-v. ★ the overlapping record is extended but keeps its later start',
    file: REC,
    find: '      moveDeviceGapStart(prior, startMs);',
    to: '      /* MUTANT */',
    why: 'The record understates the blackout by the whole hold, and its alert states the last held row as the start.',
  },
  {
    id: 'Y-vi. ★★ the overlap match accepts an earlier record',
    file: REC,
    find: '        ?? telemetryGapsLog.find((g) => g.sn === opts.sn && startMs < g.startMs && g.startMs <= endMs)',
    to: '        ?? telemetryGapsLog.find((g) => g.sn === opts.sn && g.startMs <= endMs) /* MUTANT */',
    why: 'A device that came back and went dark again extends its first record: the second blackout raises nothing.',
  },
  {
    id: 'Y-vii. ★★★ the re-date ignores the moved slice\'s end',
    file: REC,
    find: '    const g = telemetryGapsLog.find((x) => x.sn === sn && x.startMs > spanStartMs && x.startMs <= movedToMs);',
    to: '    const g = telemetryGapsLog.find((x) => x.sn === sn && x.startMs > spanStartMs); /* MUTANT */',
    why: 'The first scan moves an August span first: a Core\'s October record is re-dated to August.',
  },
  {
    id: 'Z-i. ★★ the held spans are read once per stretch again',
    file: HS,
    find: '        keepUnqualified: (startMs) => frozenEnds.has(startMs) || restored.some((r) => anchoredIn(r, startMs)),',
    to: '        keepUnqualified: (startMs) => readFrozenEnds(sn).has(startMs) || restored.some((r) => anchoredIn(r, startMs)), /* MUTANT */',
    why: 'Hundreds of thousands of lookups per device in one step of the alarm thread (1.6–5.4 s per Core on the Pi).',
  },
  {
    id: 'Z-ii. ★★ the scanner keeps every non-qualifying stretch',
    file: HS,
    find: '        keepUnqualified: (startMs) => frozenEnds.has(startMs) || restored.some((r) => anchoredIn(r, startMs)),',
    to: '        keepUnqualified: () => true, /* MUTANT */',
    why: 'Every stretch of a live device is kept until it finishes (+190–360 MB) — and moved.',
  },
  {
    id: 'Z-iii. ★★★ a return piece joins the hold before it has qualified on its own',
    file: HS,
    find: '          if (ret != null && qualifies(ret)) {',
    to: '          if (ret != null) { /* MUTANT */',
    why: 'A Core back after 9.8 silent days with one group equal to its held values has that return reading moved, and the span claims the silence.',
  },
  {
    id: 'Z-iv. ★★★ a span\'s tail is extended across any gap',
    file: HS,
    find: '          if (silenceBefore(ts)) {',
    to: '          if (silenceBefore(ts) && (anchor == null || movedThrough(anchor) == null)) { /* MUTANT */',
    why: 'When the Cores reconnect with a first group equal to their held values, the hourly scan moves their fresh return readings.',
  },
  {
    id: 'Z-v. a gap of exactly an hour is a silence, not a hole',
    file: HS,
    find: '  const silenceBefore = (ts: number) => prevRowTs != null && ts - prevRowTs > returnGapMs;',
    to: '  const silenceBefore = (ts: number) => prevRowTs != null && ts - prevRowTs >= returnGapMs; /* MUTANT */',
    why: 'A hold whose rows resume an hour after a restart (the night ledger\'s own bridge) is split, its tail a return piece that must qualify again.',
  },
  {
    id: 'Z-vi. a span an earlier scan moved is extended as a new one',
    file: HS,
    find: '      const priorEnd = job.frozenEnds.get(s.startMs);',
    to: '      const priorEnd = undefined as number | undefined; /* MUTANT */',
    why: 'A hold is announced again by every scan that extends it, and each re-moves it from the span\'s start.',
  },
  {
    id: 'Z-vii. ★★ the first scan starts at the retention horizon again',
    file: HS,
    find: '        if (Number.isFinite(oldest)) fromMs = Math.max(scanFromMs, oldest - 1);',
    to: '        /* MUTANT */',
    why: '34,666 of the first scan\'s 36,500 steps read nothing on the live database: about half its wall time on the Pi.',
  },
  {
    id: 'X-i. ★★ the held-flow estimate is the stretch\'s length again',
    file: HS,
    find: '${(v * ms / HOUR_MS / 1000).toFixed(1)}',
    to: '${(v * (job.stretch.endMs - job.stretch.firstHeldMs) / HOUR_MS / 1000).toFixed(1)}',
    why: 'The log overstates what the lifetime counters took in (400.8 kWh where the held rows covered about 36 kWh).',
  },
  {
    id: 'X-ii. ★ the tag note says the actuals were integrated from held readings',
    file: NLS,
    find: 'had no fresh readings (held or missing); `',
    to: 'had no fresh readings and the actuals were integrated from held readings; ` /* MUTANT */',
    why: 'A row whose Core wrote no rows at all is said to have been integrated from held readings.',
  },
  {
    id: 'X-iii. ★ the reset names an actual that was captured empty',
    file: NLS,
    find: "  if (v.pv.length > 0 && captured.actual_pv_kwh != null && heldRows.pv !== false) out.push('PV');",
    to: "  if (v.pv.length > 0 && heldRows.pv !== false) out.push('PV'); /* MUTANT */",
    why: 'The 10-15 note says its PV was integrated from held readings: it was captured empty.',
  },
  {
    id: 'X-iv. ★ the reset names a side that was not held',
    file: NLS,
    find: "  if (v.load.length > 0 && captured.actual_load_kwh != null && heldRows.load !== false) out.push('load');",
    to: "  if (captured.actual_load_kwh != null && heldRows.load !== false) out.push('load'); /* MUTANT */",
    why: 'The 10-15 note says its load was integrated from held readings: it came from fresh panel rows.',
  },
  {
    id: 'X-v. the sweep does not hand the reset the row as captured',
    file: IDX,
    find: 'heldRepairColumns(y, r, nameOf, heldRows));',
    to: 'heldRepairColumns({}, r, nameOf, heldRows)); /* MUTANT */',
    why: 'Every reset says nothing had been integrated from held readings.',
  },
  {
    id: 'X-vi. ★★ several dark devices each read "one device went dark"',
    file: AL,
    find: '      const alert = deviceGapAlert(g, g.sn, mins, deviceName?.(g.sn), devicesDarkAlongside(g, gaps));',
    to: '      const alert = deviceGapAlert(g, g.sn, mins, deviceName?.(g.sn), 1); /* MUTANT */',
    why: 'Four simultaneous warnings each say one device went dark.',
  },
  {
    id: 'X-vii. the dark-device count is not by overlap',
    file: AL,
    find: '    && x.startMs < g.endMs && g.startMs < x.endMs);',
    to: '    ); /* MUTANT */',
    why: 'A device dark last week is counted as dark at the same time.',
  },
  {
    id: 'X-viii. ★★ a fleet silence the gate explains blames a broker stall again',
    file: AL,
    find: '    const held = !restart && g.held != null && g.held.length > 0 ? g.held : null;',
    to: '    const held = null as TelemetryGapRecord[\'held\'] | null; /* MUTANT */',
    why: 'A panel cloud shadow while no Core reports is pushed as "an MQTT/broker stall".',
  },
  {
    id: 'X-ix. ★★ the recorder does not keep what the gate held',
    file: REC,
    find: '        silenceHeld.set(sn, (silenceHeld.get(sn) ?? false) || h.shadow);',
    to: '        /* MUTANT */',
    why: 'The same: the record carries nothing for the alert to name.',
  },
  {
    id: 'X-x. what the gate held is never cleared by a recordable home reading',
    file: REC,
    find: '      resetSilence(nowMs);\n    } else {',
    to: '      /* MUTANT */\n    } else {',
    why: 'A later true stall is blamed on a shadow that ended hours before; the evaluations are timed from the boot.',
  },
  {
    id: 'X-xi. an evaluation with a recordable home reading adds its held devices',
    file: REC,
    find: '    if (samples.some((x) => !isBenchSpareSn(x.sn) && !heldReplayFrom.has(x.sn))) {\n      resetSilence(nowMs);\n    } else {',
    to: '    if (samples.some((x) => !isBenchSpareSn(x.sn) && !heldReplayFrom.has(x.sn))) resetSilence(nowMs); /* MUTANT */\n    {',
    why: 'A Core held while the panel reports (a reading the dedupe skipped) is named in the next silence.',
  },
  // ── review round 2 ──
  {
    id: 'V-i. ★★★ the return gap is the bridge again',
    file: HS,
    find: 'export const HELD_RETURN_GAP_MS = HELD_SPAN_MIN_MS;',
    to: 'export const HELD_RETURN_GAP_MS = HELD_ROW_BRIDGE_MS; /* MUTANT */',
    why: 'A restart\'s 20-min hole leaves a running hold\'s tail in samples for good, and two 40-min parts of one hold never add up.',
  },
  {
    id: 'V-ii. ★★★ a stretch too short to be a hold is joined across a silence',
    file: HS,
    find: '            } else if (cur.heldRows > 0 && !qualifies(cur) && !(anchor != null && keep(anchor, cur.firstHeldTs))) {',
    to: '            } else if (false) { /* MUTANT */',
    why: 'A scan of the whole history moves it with the replay after the silence; an hourly scan no longer reads its fresh start and leaves it.',
  },
  {
    id: 'V-iii. ★★★ a return reading does not become the anchor',
    file: HS,
    find: '              const kept = ret.lastHeldTs;\n              close();\n              setAnchor(kept);',
    to: '              close(); /* MUTANT */',
    why: 'A replay after the return reading is a hold from the fresh reading before it in one pass and from the return reading hourly.',
  },
  {
    id: 'V-iv. ★★★ the tail of a moved span is measured from the fresh reading',
    file: HS,
    find: '        movedThroughMs: (anchorMs) => frozenEnds.get(anchorMs),',
    to: '        /* MUTANT */',
    why: 'The hourly scan reads the hours the earlier scan moved as a silence, and the running hold\'s tail must qualify again.',
  },
  {
    id: 'V-v. ★★ the held-flow estimate counts the whole stretch, not the range moved',
    file: HS,
    find: '    const ms = observedWithinMs(job.stretch, job.rangeFromMs, job.rangeToMs);',
    to: '    const ms = job.stretch.observedMs; /* MUTANT */',
    why: 'Each extension of a span re-counts the held flow of the hours already moved.',
  },
  {
    id: 'V-vi. ★★ an extension of a span states nothing',
    file: HS,
    find: '      const ext = job.extension ? ` — the held span from',
    to: '      const ext = job.extension && Date.now() < 0 /* MUTANT */ ? ` — the held span from',
    why: 'The held flow of every hour a later scan moves appears in no estimate.',
  },
  {
    id: 'V-vii. ★ the announcement states the stretch\'s end, not the move\'s',
    file: HS,
    find: 'to ${new Date(job.rangeToMs).toISOString()} (${s.metrics} metrics',
    to: 'to ${new Date(job.stretch.endMs).toISOString()} (${s.metrics} metrics',
    why: 'The line claims rows the scan left for the next one, which then states them again.',
  },
  {
    id: 'V-viii. ★★ no observed run is recorded',
    file: HS,
    find: '            else acc.observed.push([prevRowTs, ts]);',
    to: '            /* MUTANT */',
    why: 'Every held-flow estimate reads 0.0 kWh.',
  },
  {
    id: 'V-ix. ★★ a joined return piece\'s observed runs are dropped',
    file: HS,
    find: '            cur.observed.push(...ret.observed);',
    to: '            /* MUTANT */',
    why: 'A hold split by a silence is announced with the first part\'s held flow only.',
  },
  {
    id: 'V-x. ★★★ a joined return piece\'s observed time is dropped',
    file: HS,
    find: '            cur.observedMs += ret.observedMs;',
    to: '            /* MUTANT */',
    why: 'The incident\'s Cores (a 2 h outage, then 20 h restated) never qualify.',
  },
  {
    id: 'Q-i. ★★★ a restore leaves the gap record re-dated',
    file: REC,
    find: '    undateDeviceGap(sn, startMs, endMs);',
    to: '    /* MUTANT */',
    why: 'The next boot files a second record with the same alert id: two alerts with one id, Device Telemetry Gaps 24h doubled.',
  },
  {
    id: 'Q-ii. ★★ a boot after a restore by SQL does not match the start the record was filed with',
    file: REC,
    find: '        ?? telemetryGapsLog.find((g) => g.sn === opts.sn && g.startMs < startMs && (startMs <= g.endMs || startMs <= restoredEndFrom(opts.sn!, g.startMs)))',
    to: '        /* MUTANT */',
    why: 'The documented SQL recipe leads to the same second record.',
  },
  {
    id: 'Q-iii. ★★ the matched record keeps its re-dated start',
    file: REC,
    find: '      if (prior.alertStartMs === startMs && startMs > prior.startMs) {',
    to: '      if (prior.alertStartMs === startMs && startMs > prior.startMs && Date.now() < 0) { /* MUTANT */',
    why: 'The record states a start the restore declared a held span no longer.',
  },
  {
    id: 'Q-iv. ★★ a restore does not put the gap clock back',
    file: REC,
    find: '      if (lastInsertBySn.get(sn) === startMs) lastInsertBySn.set(sn, before);',
    to: '      /* MUTANT */',
    why: 'The sweep measures the device from the span\'s start and re-dates the restored record again.',
  },
  {
    id: 'Q-v. the move does not remember the clock it set back',
    file: REC,
    find: '        clockBeforeMove.set(sn, clock);',
    to: '        /* MUTANT */',
    why: 'The same: nothing to put back.',
  },
  {
    id: 'E-i. ★★ held evaluations explain a silence however far apart they were',
    file: REC,
    find: '    if (silenceHeld.size + silenceReplayed.size === 0 || Math.max(silenceEvalGapMs, nowMs - silenceEvalAtMs) > SILENCE_EVAL_MAX_GAP_MS) return undefined;',
    to: '    if (silenceHeld.size + silenceReplayed.size === 0) return undefined; /* MUTANT */',
    why: 'A true stall after a few held evaluations is filed as "held readings", not an MQTT/broker stall.',
  },
  {
    id: 'E-ii. ★ the end of the silence is not checked',
    file: REC,
    find: '    if (silenceHeld.size + silenceReplayed.size === 0 || Math.max(silenceEvalGapMs, nowMs - silenceEvalAtMs) > SILENCE_EVAL_MAX_GAP_MS) return undefined;',
    to: '    if (silenceHeld.size + silenceReplayed.size === 0 || silenceEvalGapMs > SILENCE_EVAL_MAX_GAP_MS) return undefined; /* MUTANT */',
    why: 'Evaluations that stopped 18 min before the silence ended still explain it.',
  },
  {
    id: 'E-iii. ★ a stall inside the silence is not seen',
    file: REC,
    find: '      silenceEvalGapMs = Math.max(silenceEvalGapMs, nowMs - silenceEvalAtMs);',
    to: '      /* MUTANT */',
    why: 'A 10-min stall between held evaluations is filed as "held readings".',
  },
  {
    id: 'E-iv. a held device\'s shadow flag is its last one',
    file: REC,
    find: '        silenceHeld.set(sn, (silenceHeld.get(sn) ?? false) || h.shadow);',
    to: '        silenceHeld.set(sn, h.shadow); /* MUTANT */',
    why: 'A panel shadowed for most of the silence is named as merely stale.',
  },
  {
    id: 'E-v. ★ bench spares are named in what the gate held',
    file: REC,
    find: '        if (SYNTHETIC_SNS.has(sn) || isBenchSpareSn(sn)) continue;\n        silenceHeld.set(',
    to: '        silenceHeld.set( /* MUTANT */',
    why: 'A spare, dark by design, is named in every in-process fleet gap after it reported once.',
  },
  {
    id: 'E-vi. the post-boot silence never carries what the gate held',
    file: REC,
    find: '      if (postBootSilence) recordTelemetryGap(now - Math.round(sinceBootMs), now, { held: silenceHeldList(now), unmeasured: silenceUnmeasuredList() });',
    to: '      if (postBootSilence) recordTelemetryGap(now - Math.round(sinceBootMs), now); /* MUTANT */',
    why: 'A boot whose first 20 min the gate held is pushed as an MQTT/broker stall.',
  },
  // ── review round 3 ──
  {
    id: 'A-i. ★★★ a re-read opens a return piece after a kept anchor\'s moved span',
    file: HS,
    find: '            if (silenceBefore(ts)) ret = newStretchAcc();',
    to: '            ret = newStretchAcc(); /* MUTANT */',
    why: 'The boot scan after a stop, the 3 h overlap and the retry after a failed slice leave the rest of a hold that ended within the hour in samples for good.',
  },
  {
    id: 'A-ii. ★ a re-dated record is logged at its last fresh reading again',
    file: REC,
    find: 'to ${new Date(spanStartMs).toISOString()}, its newest row left in samples (the rows after it were held restatements',
    to: 'to its last fresh reading ${new Date(spanStartMs).toISOString()} (the rows between were held restatements /* MUTANT */',
    why: 'A span that starts at a kept restated row is logged as the device\'s last fresh reading: the restatements before it are still in samples.',
  },
  {
    id: 'A-iii. ★★★ the move sets back only a seeded gap clock',
    file: REC,
    find: '      if (clock != null && clock > startMs && (clock <= through || (!seededNotYetWritten.has(sn) && restatedSince(sn, through, heldValues)))) {',
    to: '      if (seededNotYetWritten.has(sn) && clock != null && clock > startMs && clock <= through) { /* MUTANT */',
    why: 'A Core whose replayed body was written in this process is filed 6 h after its last held row, a hold late, with a start nothing measured.',
  },
  {
    id: 'A-iv. ★ a restore puts back only a seeded gap clock',
    file: REC,
    find: '      if (lastInsertBySn.get(sn) === startMs) lastInsertBySn.set(sn, before);',
    to: '      if (seededNotYetWritten.has(sn) && lastInsertBySn.get(sn) === startMs) lastInsertBySn.set(sn, before); /* MUTANT */',
    why: 'An in-process clock stays on the span\'s start after its rows are back in samples.',
  },
  {
    id: 'A-v. ★ a restore of any span forgets the clock the move set back',
    file: REC,
    find: '    const before = clockBeforeMove.get(sn);\n    const replayed',
    to: '    const before = clockBeforeMove.get(sn);\n    clockBeforeMove.delete(sn); /* MUTANT */\n    const replayed',
    why: 'Restoring an older span first loses the current span\'s clock: the next sweep re-dates the restored record again.',
  },
  {
    id: 'A-vi. ★ the move re-dates a record only when it set a clock back',
    file: REC,
    find: '      }\n      redateDeviceGap(sn, startMs, endMs);\n    },',
    to: '      }\n      if (lastInsertBySn.get(sn) === startMs) redateDeviceGap(sn, startMs, endMs); /* MUTANT */\n    },',
    why: 'A device back fresh before the first scan keeps its record\'s held-row start for good (the next boot\'s seed is newer).',
  },
  {
    id: 'A-vii. ★★ a gate span is read as a moved frozen span',
    file: HS,
    find: "  frozenOf: \"SELECT start_ts, end_ts FROM held_spans WHERE sn = ? AND reason = 'frozen' AND restored_at_ms IS NULL\",",
    to: "  frozenOf: \"SELECT start_ts, end_ts FROM held_spans WHERE sn = ? AND restored_at_ms IS NULL\", /* MUTANT */",
    why: 'A gate span from the last fresh row\'s own ms makes the device\'s fresh return readings a moved hold\'s tail.',
  },
  {
    id: 'A-viii. ★★ a return piece that joins on its last row leaves the stretch\'s end behind',
    file: HS,
    find: '            cur.lastHeldTs = ret.lastHeldTs;',
    to: '            /* MUTANT */',
    why: 'The span ends before the replay that joined it (or nothing is moved), and the replay stays in samples.',
  },
  {
    id: 'A-ix. ★★ a return piece that joins on its last row adds none of its rows',
    file: HS,
    find: '            cur.heldRows += ret.heldRows;',
    to: '            /* MUTANT */',
    why: 'An outage followed by an hour of replay is never moved.',
  },
  {
    id: 'A-x. ★★ the first scan starts at the last listed metric\'s oldest row',
    file: HS,
    find: '          if (v != null && Number(v) < oldest) oldest = Number(v);',
    to: '          if (v != null) oldest = Number(v); /* MUTANT */',
    why: 'A metric added later (last in name order) hides the device\'s earlier history from the only scan that reads it.',
  },
  {
    id: 'A-xi. ★ the stall measure is not reset between silences',
    file: REC,
    find: '    silenceEvalAtMs = atMs;\n    silenceEvalGapMs = 0;\n  };',
    to: '    silenceEvalAtMs = atMs;\n  }; /* MUTANT */',
    why: 'After one stalled silence every later held silence is blamed on an MQTT/broker stall.',
  },
  {
    id: 'A-xii. ★ what the gate held is not cleared between silences',
    file: REC,
    find: '  const resetSilence = (atMs: number) => {\n    silenceHeld.clear();',
    to: '  const resetSilence = (atMs: number) => { /* MUTANT */',
    why: 'A later silence names the devices and shadow flags of an earlier one.',
  },
  {
    id: 'A-xiii. the devices read with nothing measurable are not cleared between silences',
    file: REC,
    find: '    silenceUnmeasured.clear();',
    to: '    /* MUTANT */',
    why: 'A later silence names a device read with nothing measurable in an earlier one.',
  },
  {
    id: 'A-xiv. ★ a bench spare\'s fresh rows end a held silence',
    file: REC,
    find: '    if (samples.some((x) => !isBenchSpareSn(x.sn) && !heldReplayFrom.has(x.sn))) {\n      resetSilence(nowMs);',
    to: '    if (samples.some((x) => !heldReplayFrom.has(x.sn))) { /* MUTANT */\n      resetSilence(nowMs);',
    why: 'A spare reporting through a held silence leaves it unexplained: pushed as an MQTT/broker stall.',
  },
  {
    id: 'A-xv. ★ the recorder does not keep the devices read with nothing measurable',
    file: REC,
    find: '        silenceUnmeasured.add(d.sn);',
    to: '        /* MUTANT */',
    why: 'The alert says every home device it read was held while one was read fresh.',
  },
  {
    id: 'A-xvi. a device held in the silence is also named as read with nothing measurable',
    file: REC,
    find: '[...silenceUnmeasured].filter((sn) => !silenceHeld.has(sn) && !silenceReplayed.has(sn)).sort(bySn);',
    to: '[...silenceUnmeasured].sort(bySn); /* MUTANT */',
    why: 'A panel whose shadow released on an empty body is named both as held and as reporting nothing measurable.',
  },
  {
    id: 'A-xvii. ★ the alert ignores the devices read with nothing measurable',
    file: AL,
    find: '${heldGapPhrase(held, deviceName, g.unmeasured ?? [])}',
    to: '${heldGapPhrase(held, deviceName)} /* MUTANT */',
    why: 'The push says every home device it read was held.',
  },
  {
    id: 'A-xviii. the phrase says every home device was held whatever was read',
    file: AL,
    find: '  if (unmeasured.length === 0) return `every home device it had a reading for was held',
    to: '  if (unmeasured.length >= 0) return `every home device it had a reading for was held /* MUTANT */',
    why: 'The same, from the phrase.',
  },
  {
    id: 'A-xix. ★★ the dark-device count is by overlap with the window again, not at one instant',
    file: AL,
    find: '    for (const x of others) if (x.startMs <= at && at < x.endMs) sns.add(x.sn!);',
    to: '    for (const x of others) sns.add(x.sn!); /* MUTANT */',
    why: 'Two devices dark at either end of a long record, never together, are pushed as three dark at the same time.',
  },
  {
    id: 'A-xx. ★ the reset note ignores whether a held row lay inside the span',
    file: NLS,
    find: "  if (v.pv.length > 0 && captured.actual_pv_kwh != null && heldRows.pv !== false) out.push('PV');",
    to: "  if (v.pv.length > 0 && captured.actual_pv_kwh != null) out.push('PV'); /* MUTANT */",
    why: 'A row whose span overlapped only a frozen span\'s silent hours is said to have been integrated from held readings.',
  },
  {
    id: 'A-xxi. the sweep does not look the held rows up',
    file: IDX,
    find: "      const heldRows = r.action === 'recapture' && r.verdict != null ? { pv: heldIn(r.verdict.pv, 'pv_total'), load: heldIn(r.verdict.load, 'panel_load') } : {};",
    to: '      const heldRows = {}; /* MUTANT */',
    why: 'The same, from the sweep.',
  },
  {
    id: 'A-xxii. heldRowsWithin finds a held row everywhere',
    file: HS,
    find: '    return heldRowWithinStmt.get(sn, sinceMs, untilMs, metric) != null;',
    to: '    return true; /* MUTANT */',
    why: 'The same, from the store.',
  },
  {
    id: 'A-xxiii. ★ the documented SQL restore drops the samples-generation step',
    file: ARCH,
    find: ', and advance the samples\ngeneration with `UPDATE held_generation SET gen = gen + 1 WHERE id = 1`. Without that last step the\nanalytics worker\'s closed-day memos and report caches (above) keep serving the days without the\nrestored rows until the next restart: the generation is the only signal that `samples` changed\nother than by appending.',
    to: '. <!-- MUTANT -->',
    why: 'A restore by SQL leaves the worker serving the days without the restored rows until the next restart.',
  },
  // ── review round 4 ──
  {
    id: 'B-i. ★★★ a restored span is matched on overlap alone',
    file: HS,
    find: 'const continuesRestored = (r: { startMs: number; endMs: number }, s: Pick<FrozenStretch, \'startMs\' | \'endMs\'>): boolean => overlapMs(r.startMs, r.endMs, s.startMs, s.endMs) > 0 || anchoredIn(r, s.startMs);',
    to: 'const continuesRestored = (r: { startMs: number; endMs: number }, s: Pick<FrozenStretch, \'startMs\' | \'endMs\'>): boolean => overlapMs(r.startMs, r.endMs, s.startMs, s.endMs) > 0; /* MUTANT */',
    why: 'A restore made while the device still restates its readings holds for about four hours: then the rest of the hold is moved as a new span, a second HELD SAMPLES line, and the ledger refuses those hours again.',
  },
  {
    id: 'B-ii. ★★ the restored span\'s end does not follow its hold',
    file: HS,
    find: '        extendRestoredStmt.run(s.endMs, sn, r.startMs, s.endMs);\n        r.endMs = s.endMs;',
    to: '            /* MUTANT */',
    why: 'Once the 3 h re-read starts after the restored end, the scan\'s anchor is a restated row outside it: the same as matching on overlap alone.',
  },
  {
    id: 'B-iii. ★★ the scanner does not keep a stretch anchored in a restored span',
    file: HS,
    find: '        keepUnqualified: (startMs) => frozenEnds.has(startMs) || restored.some((r) => anchoredIn(r, startMs)),',
    to: '        keepUnqualified: (startMs) => frozenEnds.has(startMs), /* MUTANT */',
    why: 'A sparse continuation that no hourly re-read qualifies never moves the restored end: a boot scan after a stop, which reads more of it, moves it as a new span.',
  },
  {
    id: 'B-iv. the continuation of a restored span is logged by every scan',
    file: HS,
    find: '    if (!restoredNoted.has(key)) {',
    to: '        if (true) { /* MUTANT */',
    why: 'One line an hour for as long as a restored hold runs, in the log ring.',
  },
  {
    id: 'B-v. ★★★ a seed inside a device record\'s window is matched only on the start a re-dated record was filed with',
    file: REC,
    find: '        ?? telemetryGapsLog.find((g) => g.sn === opts.sn && g.startMs < startMs && (startMs <= g.endMs || startMs <= restoredEndFrom(opts.sn!, g.startMs)))',
    to: '        ?? telemetryGapsLog.find((g) => g.sn === opts.sn && g.alertStartMs === startMs) /* MUTANT */',
    why: 'After a restore of the span a record was filed at, the next boot files a second record with a new id: a second pushed warning for the same darkness.',
  },
  {
    id: 'B-vi. ★★ the record matched inside its window takes the seed\'s start',
    file: REC,
    find: '      if (opts?.sn && startMs > prior.startMs && prior.alertStartMs !== startMs) keptFrom = startMs;',
    to: '      if (opts?.sn && startMs > prior.startMs && prior.alertStartMs !== startMs) { keptFrom = startMs; prior.startMs = startMs; } /* MUTANT */',
    why: 'The warning\'s time and its id move to the restored row: pushed again.',
  },
  {
    id: 'B-vii. the gap line states the seed\'s start, not the record\'s window',
    file: REC,
    find: '    const range = `${new Date(gap.startMs).toISOString()} → ${new Date(gap.endMs).toISOString()}`;',
    to: '    const range = `${new Date(startMs).toISOString()} → ${new Date(endMs).toISOString()}`; /* MUTANT */',
    why: 'The DEVICE TELEMETRY GAP line gives a start the record does not have.',
  },
  {
    id: 'B-viii. ★★★ the move sets a clock back only within the moved rows',
    file: REC,
    find: '      if (clock != null && clock > startMs && (clock <= through || (!seededNotYetWritten.has(sn) && restatedSince(sn, through, heldValues)))) {',
    to: '      if (clock != null && clock > startMs && clock <= endMs) { /* MUTANT */',
    why: 'A replay still being written has its clock past every moved range (rows younger than 15 min wait): no warning while it lasts, none if it ends with a fresh reading.',
  },
  {
    id: 'B-ix. ★★ the scan does not say where the stretch\'s restatements end',
    file: HS,
    find: '    if (moved > 0) o.onMoved?.(job.sn, job.spanStartMs, job.toMs, Math.max(job.toMs, job.stretch.endMs), job.stretch.heldValues);',
    to: '    if (moved > 0) o.onMoved?.(job.sn, job.spanStartMs, job.toMs, job.toMs, job.stretch.heldValues); /* MUTANT */',
    why: 'The same, from the store.',
  },
  {
    id: 'B-x. ★★★ a restated write of a held Core resets its clock',
    file: REC,
    find: '        if (hold != null && prevRow != null && prevRow.value === s.value && now - prevRow.ts <= HELD_RETURN_GAP_MS) {',
    to: '        if (false) { /* MUTANT */',
    why: 'Each replayed write re-arms the sweep and resets the clock: the replay is never filed while it runs.',
  },
  {
    id: 'B-xi. ★★ a write after more than an hour without one stays held',
    file: REC,
    find: '        if (hold != null && prevRow != null && prevRow.value === s.value && now - prevRow.ts <= HELD_RETURN_GAP_MS) {',
    to: '        if (hold != null && prevRow != null && prevRow.value === s.value) { /* MUTANT */',
    why: 'A Core back after a silence with its last readings (a return the scan keeps) is still counted dark from the hold\'s start: a gap filed while it reports.',
  },
  {
    id: 'B-xii. ★★ a changed write does not end the hold',
    file: REC,
    find: '        heldReplayFrom.delete(s.sn);\n        if (prevWrite != null',
    to: '        // MUTANT\n        if (prevWrite != null',
    why: 'After a fresh reading every steady heartbeat leaves the clock at it: the next gap is filed early, from the change.',
  },
  {
    id: 'B-xiii. ★★ a restore does not end the hold',
    file: REC,
    find: '    if (replayed) heldReplayFrom.delete(sn);',
    to: '    /* MUTANT */',
    why: 'A replay whose span was restored is still held: a gap is filed while its readings are back in samples.',
  },
  {
    id: 'B-xiv. ★ a restore of a running replay leaves the clock at the span\'s start',
    file: REC,
    find: '    if (before != null && before > startMs && (before <= endMs || replayed)) {',
    to: '    if (before != null && before > startMs && before <= endMs) { /* MUTANT */',
    why: 'Its last restated write lies past the restored end: a silence after the restore is measured from the span\'s start, hours early.',
  },
  {
    id: 'B-xv. ★★ a moved span\'s tail is re-anchored at its own last row across a silence',
    file: HS,
    find: '            } else if (cur.heldRows > 0 && !qualifies(cur) && !(anchor != null && keep(anchor, cur.firstHeldTs))) {',
    to: '            } else if (cur.heldRows > 0 && !qualifies(cur)) { /* MUTANT */',
    why: 'A replay after the silence becomes a second span from a moved row: onMoved sets the gap clock to a row not in samples, and the warning comes a hold late.',
  },
  {
    id: 'B-xvi. ★★ a return piece that never qualified carries across a fresh change',
    file: HS,
    find: '    ret = null; // a return piece that never qualified: return readings, left in samples',
    to: '    /* MUTANT */',
    why: 'Quiet rows of a live device after a change add to the return piece\'s observed time and are moved out of samples.',
  },
  {
    id: 'B-xvii. ★ a joined return piece\'s values are dropped',
    file: HS,
    find: '            for (const [m, v] of ret.values) cur.values.set(m, v);',
    to: '            /* MUTANT */',
    why: 'The HELD SAMPLES line of a replay after an outage gives no held-flow estimate.',
  },
  {
    id: 'B-xviii. a flow held at 0 W is stated as integrated energy',
    file: HS,
    find: '    const flows = [...job.stretch.heldValues].filter(([m, v]) => LIFETIME_FLOW_METRIC.test(m) && v > 0);',
    to: '    const flows = [...job.stretch.heldValues].filter(([m]) => LIFETIME_FLOW_METRIC.test(m)); /* MUTANT */',
    why: '"0.0 kWh of pv_total" in the HELD SAMPLES line.',
  },
  {
    id: 'B-xix. ★ the load side ignores whether a held row lay inside the span',
    file: NLS,
    find: "  if (v.load.length > 0 && captured.actual_load_kwh != null && heldRows.load !== false) out.push('load');",
    to: "  if (v.load.length > 0 && captured.actual_load_kwh != null) out.push('load'); /* MUTANT */",
    why: 'A load actual captured over only a held panel span\'s silent hours is said to be integrated from held readings, and over hours with none, in one note.',
  },
  {
    id: 'B-xx. ★ the load side is never described as integrated over hours with no readings',
    file: NLS,
    find: "  if (v.load.length > 0 && captured.actual_load_kwh != null && heldRows.load === false) across.push('load');",
    to: '  /* MUTANT */',
    why: 'A 20.5 kWh load actual is described as "captured empty".',
  },
  {
    id: 'B-xxi. ★ the repair hands back the 24 h span, not the span as captured',
    file: NLS,
    find: "  if (inside) return { action: 'recapture', verdict, span, added, restored };",
    to: "  if (inside) return { action: 'recapture', verdict, span: { startMs: issued, endMs: issued + FORECAST_SPAN_MS }, added, restored }; /* MUTANT */",
    why: 'A row captured short of 24 h has its held rows looked up after its capture.',
  },
  {
    id: 'B-xxii. ★ a device listed with no projection is named as read with nothing measurable',
    file: REC,
    find: '        if (!d.projection || held.has(d.sn) || SYNTHETIC_SNS.has(d.sn) || isBenchSpareSn(d.sn)) continue;',
    to: '        if (held.has(d.sn) || SYNTHETIC_SNS.has(d.sn) || isBenchSpareSn(d.sn)) continue; /* MUTANT */',
    why: 'After a restart with the Cores offline in the cloud, the push says Cores that were never read "reported nothing measurable".',
  },
  {
    id: 'B-xxiii. ★ the re-date has no lower bound',
    file: REC,
    find: '    const g = telemetryGapsLog.find((x) => x.sn === sn && x.startMs > spanStartMs && x.startMs <= movedToMs);',
    to: '    const g = telemetryGapsLog.find((x) => x.sn === sn && x.startMs <= movedToMs); /* MUTANT */',
    why: 'An older, closed record of the device is found first: the current one keeps its held-row start.',
  },
  {
    id: 'B-xxiv. ★ a record re-dated twice takes its second start as its id',
    file: REC,
    find: '    g.alertStartMs ??= g.startMs;',
    to: '    g.alertStartMs = g.startMs; /* MUTANT */',
    why: 'Its alert id changes: the same blackout is pushed again.',
  },
  {
    id: 'B-xxv. ★ a restore sets back a clock the device has written since',
    file: REC,
    find: '      if (lastInsertBySn.get(sn) === startMs) lastInsertBySn.set(sn, before);',
    to: '      lastInsertBySn.set(sn, before); /* MUTANT */',
    why: 'A Core back fresh after the move is measured from an old restated row: a gap filed early.',
  },
  {
    id: 'B-xxvi. a record that begins as another ends is dark at the same time',
    file: AL,
    find: '    && x.startMs < g.endMs && g.startMs < x.endMs);',
    to: '    && x.startMs <= g.endMs && g.startMs < x.endMs); /* MUTANT */',
    why: '"2 home devices were dark at the same time" for two devices dark one after the other.',
  },
  // ── review round 5 ──
  {
    id: 'H-i. ★★ the sweep never looks a restored span up',
    file: REC,
    find: '          const restored = heldStore.restoredSpanFrom(sn, lastMs);',
    to: '          const restored = null as { startMs: number; endMs: number } | null; /* MUTANT */',
    why: 'After the documented SQL restore of a replay still running, the Core goes on restating the restored readings, every row in samples, and is pushed as dark 6 h after the span\'s start.',
  },
  {
    id: 'H-ii. ★ the restored-span lookup finds nothing',
    file: HS,
    find: '      return r == null ? null : { startMs, endMs: Number(r.end_ts) };',
    to: '      void r; return null; /* MUTANT */',
    why: 'The same, from the store.',
  },
  {
    id: 'H-iii. ★★ the restored-span lookup reads any frozen span',
    file: HS,
    find: "  restoredFrom: \"SELECT end_ts FROM held_spans WHERE sn = ? AND start_ts = ? AND reason = 'frozen' AND restored_at_ms IS NOT NULL\",",
    to: "  restoredFrom: \"SELECT end_ts FROM held_spans WHERE sn = ? AND start_ts = ? AND reason = 'frozen'\", // MUTANT",
    why: 'Every replay still being written is released 6 h after its start instead of filed: no warning while it lasts.',
  },
  {
    id: 'H-iv. ★ the sweep skips a restored span\'s device without releasing it',
    file: REC,
    find: '            restoredSpanBack(sn, restored.startMs, restored.endMs);\n            if ((lastInsertBySn.get(sn) ?? lastMs) > lastMs) continue;',
    to: '            continue; /* MUTANT */',
    why: 'The device stays held at the span\'s start: when it falls silent it is never filed.',
  },
  {
    id: 'H-v. ★★★ a record is filed from a seeded clock before the first scan',
    file: REC,
    find: '          if (seededNotYetWritten.has(sn) && heldScanScheduled && !heldStore.isReady()) continue;',
    to: '          /* MUTANT */',
    why: 'The upgrade boot pushes "no data for 420 min" from the last held row; the scan re-dates the record under the same id, so the 2820 min is never pushed.',
  },
  {
    id: 'H-vi. ★★ the wait ignores whether the scan runs here',
    file: REC,
    find: '          if (seededNotYetWritten.has(sn) && heldScanScheduled && !heldStore.isReady()) continue;',
    to: '          if (seededNotYetWritten.has(sn) && !heldStore.isReady()) continue; /* MUTANT */',
    why: 'Outside the add-on (no scan) a device dark at a boot is never filed.',
  },
  {
    id: 'H-vii. ★★★ the move holds a clock only up to the rows the scan read',
    file: REC,
    find: '      if (clock != null && clock > startMs && (clock <= through || (!seededNotYetWritten.has(sn) && restatedSince(sn, through, heldValues)))) {',
    to: '      if (clock != null && clock > startMs && clock <= through) { /* MUTANT */',
    why: 'A heartbeat between the scan\'s plan and its move leaves a replayed Core unheld: its warning comes at the next hourly scan, or never.',
  },
  {
    id: 'H-viii. ★★ a value that changed and changed back after the plan is a restatement',
    file: REC,
    find: '    if ((lastChangeBySn.get(sn) ?? Number.NEGATIVE_INFINITY) > throughMs) return false;',
    to: '    /* MUTANT */',
    why: 'A Core that read fresh in that window is held from the old span\'s start: a warning filed early.',
  },
  {
    id: 'H-ix. ★★ a first write after the plan is not compared with its held value',
    file: REC,
    find: '      if (w.ts > throughMs && k.startsWith(prefix) && values.get(k.slice(prefix.length)) !== w.value) return false;',
    to: '      void k; void w; /* MUTANT */',
    why: 'A Core whose first reading after a restart changed is held from the span\'s start: a warning filed while it reports.',
  },
  {
    id: 'H-x. ★★ a write after the plan more than an hour after the last restated row is still the hold',
    file: REC,
    find: '    if ((lastInsertBySn.get(sn) ?? Number.POSITIVE_INFINITY) - throughMs > HELD_RETURN_GAP_MS) return false;',
    to: '    /* MUTANT */',
    why: 'A Core back after a silence with its last readings (a return the scan keeps) is counted dark from the hold\'s start.',
  },
  {
    id: 'H-xi. ★★★ a first write after a restart is compared with nothing',
    file: REC,
    find: '        const prevRow = prevWrite ?? (hold == null ? undefined : { ts: hold.throughMs, value: hold.values.get(s.metric) });',
    to: '        const prevRow = prevWrite; /* MUTANT */',
    why: 'The boot scan holds a replayed Core and its first write after it ends the hold: the warning comes at the next hourly scan, or never.',
  },
  {
    id: 'H-xii. ★★ a first write after a restart is compared with its own value',
    file: REC,
    find: '        const prevRow = prevWrite ?? (hold == null ? undefined : { ts: hold.throughMs, value: hold.values.get(s.metric) });',
    to: '        const prevRow = prevWrite ?? (hold == null ? undefined : { ts: hold.throughMs, value: s.value }); /* MUTANT */',
    why: 'A Core whose first reading after the restart changed stays held: a warning filed while it reports.',
  },
  {
    id: 'H-xiii. ★★ a first write after a restart is held across any silence',
    file: REC,
    find: '        const prevRow = prevWrite ?? (hold == null ? undefined : { ts: hold.throughMs, value: hold.values.get(s.metric) });',
    to: '        const prevRow = prevWrite ?? (hold == null ? undefined : { ts: now, value: hold.values.get(s.metric) }); /* MUTANT */',
    why: 'A Core back after a 70-min silence with its last readings is counted dark from the hold\'s start.',
  },
  {
    id: 'H-xiv. ★ the hold remembers the moved end, not the last restated row',
    file: REC,
    find: '        heldReplayFrom.set(sn, { startMs, values: heldValues, throughMs: through });',
    to: '        heldReplayFrom.set(sn, { startMs, values: heldValues, throughMs: endMs }); /* MUTANT */',
    why: 'The rows under 15 min old the scan left are not counted: a Core back within the hour after a restart reads as a return.',
  },
  {
    id: 'H-xv. ★★ the re-date merges nothing',
    file: REC,
    find: '        telemetryGapsLog.splice(i, 1);\n        merged++;',
    to: '        merged += 0; /* MUTANT */',
    why: 'Two records claim one darkness from one start, under two ids; Device Telemetry Gaps 24h at 2.',
  },
  {
    id: 'H-xvi. ★ the merge reaches a record before the span',
    file: REC,
    find: '      if (x !== g && x.sn === sn && x.startMs >= spanStartMs && x.startMs <= movedToMs) {',
    to: '      if (x !== g && x.sn === sn && x.startMs <= movedToMs) { /* MUTANT */',
    why: 'An older, closed blackout of the device disappears from the record.',
  },
  {
    id: 'H-xvii. ★ the merge reaches a record of a later darkness',
    file: REC,
    find: '      if (x !== g && x.sn === sn && x.startMs >= spanStartMs && x.startMs <= movedToMs) {',
    to: '      if (x !== g && x.sn === sn && x.startMs >= spanStartMs) { /* MUTANT */',
    why: 'The first scan after an upgrade drops the record of the device\'s current darkness while it moves an old hold.',
  },
  {
    id: 'H-xviii. ★★ the merge drops the re-dated record too',
    file: REC,
    find: '      if (x !== g && x.sn === sn && x.startMs >= spanStartMs && x.startMs <= movedToMs) {',
    to: '      if (x.sn === sn && x.startMs >= spanStartMs && x.startMs <= movedToMs) { /* MUTANT */',
    why: 'The darkness loses every record.',
  },
  {
    id: 'H-xix. ★ the move keeps a clock remembered by an earlier move',
    file: REC,
    find: '        clockBeforeMove.set(sn, clock);',
    to: '        if (!clockBeforeMove.has(sn)) clockBeforeMove.set(sn, clock); /* MUTANT */',
    why: 'A restore of a second replay\'s span measures the silence after it from the span\'s start: a warning filed 100 min early, from a row back in samples.',
  },
  {
    id: 'H-xx. ★ a record extended from a seed inside its window states the seed\'s duration',
    file: REC,
    find: '      prior.durationMs = endMs - prior.startMs;',
    to: '      prior.durationMs = endMs - startMs; /* MUTANT */',
    why: '"no data for 503 min" over a window of 48 h.',
  },
  {
    id: 'H-xxi. ★★ the move hands the recorder no held values',
    file: HS,
    find: '    if (moved > 0) o.onMoved?.(job.sn, job.spanStartMs, job.toMs, Math.max(job.toMs, job.stretch.endMs), job.stretch.heldValues);',
    to: '    if (moved > 0) o.onMoved?.(job.sn, job.spanStartMs, job.toMs, Math.max(job.toMs, job.stretch.endMs), new Map()); /* MUTANT */',
    why: 'A heartbeat after the plan, and the first write after a restart, never restate the hold.',
  },
  {
    id: 'H-xxii. ★★★ heldSides reads PV from the load side',
    file: NLS,
    find: '  return { pv: v != null && v.pv.length > 0, load: v != null && v.load.length > 0 };',
    to: '  return { pv: v != null && v.load.length > 0, load: v != null && v.load.length > 0 }; /* MUTANT */',
    why: 'A row with a Core held for an hour or more integrates its PV over the replay into pv_in_band and pv_err_frac (survivor W1).',
  },
  {
    id: 'H-xxiii. ★★ heldSides holds PV whenever anything is held',
    file: NLS,
    find: '  return { pv: v != null && v.pv.length > 0, load: v != null && v.load.length > 0 };',
    to: '  return { pv: v != null, load: v != null && v.load.length > 0 }; /* MUTANT */',
    why: 'PV is withheld whenever only the panel was held (survivor W2).',
  },
  {
    id: 'H-xxiv. ★★ the scorer withholds PV on the load side',
    file: IDX,
    find: '    const pvHeld = heldSide.pv;',
    to: '    const pvHeld = heldSide.load; /* MUTANT */',
    why: 'The same, from the scorer.',
  },
  {
    id: 'H-xxv. ★ the scorer withholds load on the PV side',
    file: IDX,
    find: '  const actualLoadKwh = loadPts.length && !heldSide.load ? round2(integrateWh(loadPts, false) / 1000) : null;',
    to: '  const actualLoadKwh = loadPts.length && !heldSide.pv ? round2(integrateWh(loadPts, false) / 1000) : null; /* MUTANT */',
    why: 'A load the panel did not report is integrated when only the panel was held.',
  },
  {
    id: 'H-xxvi. ★★ the repair reads the marker per row again',
    file: NLS,
    find: '  const added = sidesWhere(held.pv && !noted.pv, held.load && !noted.load);',
    to: '  const added = sidesWhere(held.pv && !(noted.pv || noted.load), held.load && !(noted.pv || noted.load)); /* MUTANT */',
    why: 'A row captured with the panel\'s hold stated and a replayed Core found after the capture keeps its PV integrated from the replay.',
  },
  {
    id: 'H-xxvii. ★★ a side whose span was restored is never repaired',
    file: NLS,
    find: '  const restored = sidesWhere(noted.pv && !held.pv && restoredIn(i.coreSns), noted.load && !held.load && restoredIn([i.panelSn]));',
    to: '  const restored = sidesWhere(false, false); /* MUTANT */',
    why: 'After a restore the row says "not scored — telemetry held" with its actual empty for good, against history that says the readings were real.',
  },
  {
    id: 'H-xxviii. ★ a restored side past the horizon is tagged',
    file: NLS,
    find: "  return added.length === 0 ? null : { action: 'tag', verdict, span, added, restored: [] };",
    to: "  return { action: 'tag', verdict, span, added, restored: [] }; /* MUTANT */",
    why: 'A tag with no side to name, on every sweep.',
  },
  {
    id: 'H-xxix. ★ heldSidesNoted reads only the first held clause',
    file: NLS,
    find: '  for (let i = lower.indexOf(head); i >= 0; i = lower.indexOf(head, i + head.length)) {',
    to: '  for (let i = lower.indexOf(head); i >= 0; i = -1) { /* MUTANT */',
    why: 'A side tagged after the capture is found owing a repair again: tagged on every sweep.',
  },
  {
    id: 'H-xxx. ★ heldSidesNoted never reads a load part',
    file: NLS,
    find: "      if (part.startsWith('load — ')) out.load = true;",
    to: '      /* MUTANT */',
    why: 'Every row refused for a held panel is reset on every sweep.',
  },
  {
    id: 'H-xxxi. ★ the tag drops the notes as captured',
    file: NLS,
    find: "  if (r.action === 'tag') return { score_notes: `${row.score_notes ?? ''} ${heldTagNote(found!, name)}`.trim() };",
    to: "  if (r.action === 'tag') return { score_notes: heldTagNote(found!, name) }; /* MUTANT */",
    why: 'A row past the horizon loses its captured notes, the reason it was scored or not (survivor N13).',
  },
  {
    id: 'H-xxxii. the tag names every held side, not the one found',
    file: NLS,
    find: "  if (r.action === 'tag') return { score_notes: `${row.score_notes ?? ''} ${heldTagNote(found!, name)}`.trim() };",
    to: "  if (r.action === 'tag') return { score_notes: `${row.score_notes ?? ''} ${heldTagNote(r.verdict!, name)}`.trim() }; /* MUTANT */",
    why: 'The side already stated is stated twice.',
  },
  {
    id: 'H-xxxiii. the reset clause describes every held side, not the one found',
    file: NLS,
    find: '  if (r.verdict != null && r.added.length > 0) parts.push(heldCapturedClause(verdictOf(r.verdict, r.added), captured, heldRows));',
    to: '  if (r.verdict != null && r.added.length > 0) parts.push(heldCapturedClause(r.verdict, captured, heldRows)); /* MUTANT */',
    why: 'The reset line says the load side, already stated and left empty, "had been captured empty".',
  },
  {
    id: 'H-xxxiv. ★ a degenerate stored window is a window',
    file: NLS,
    find: "  if (typeof ws !== 'number' || typeof we !== 'number' || !(we > ws)) return null; // no window: nothing was integrated",
    to: "  if (typeof ws !== 'number' || typeof we !== 'number') return null; /* MUTANT */",
    why: 'A row the windowless branch captured with no marker is reset on every sweep (survivor N5).',
  },
  {
    id: 'H-xxxv. ★ the repair reads two days of spans',
    file: IDX,
    find: '    const spans = recorder.heldSpans?.(nowMs - (LEDGER_BACKFILL_SWEEP_DAYS + 2) * 86_400_000, nowMs);',
    to: '    const spans = recorder.heldSpans?.(nowMs - 2 * 86_400_000, nowMs); /* MUTANT */',
    why: 'A row whose hold ended more than two days ago keeps a score on held readings (survivor N14).',
  },
  {
    id: 'H-xxxvi. ★★ the repair returns when no span is left',
    file: IDX,
    find: '    if (spans == null) return false;',
    to: '    if (spans == null || spans.length === 0) return false; /* MUTANT */',
    why: 'With every span restored, the rows refused for them are never re-captured.',
  },
  {
    id: 'H-xxxvii. ★★ the repair writes nothing',
    file: IDX,
    find: '      recorder.recordNightOutcome(String(y.plan_date), heldRepairColumns(y, r, nameOf, heldRows));',
    to: '      /* MUTANT */',
    why: 'A row past the horizon gets no clause and is logged as tagged on every sweep; a reset never resets (survivor N12).',
  },
  {
    id: 'H-xxxviii. the restore line does not say where the hold it gives back ends',
    file: HS,
    find: ' — the hold ends when a reading changes, or when the device comes back from a silence of more than an hour with a return reading and falls silent again (a later replay is then a new hold)`);',
    to: '`); /* MUTANT */',
    why: 'An owner told that the rest of the hold will not be excluded again sees a later replay moved after one return reading.',
  },
  {
    id: 'H-xxxix. ★ a side no longer held counts as restored without a restored span',
    file: NLS,
    find: '  const restoredIn = (sns: readonly string[]) => (i.restored ?? []).some((r) => sns.includes(r.sn) && overlapOf(r, span) > 0);',
    to: '  const restoredIn = (sns: readonly string[]) => sns.length >= 0; /* MUTANT */',
    why: 'A Core no longer on the panel makes every row refused for it re-captured, its note saying the readings were restored.',
  },
  {
    id: 'H-xl. ★ restoredSpans lists every frozen span, restored or not',
    file: HS,
    find: '      WHERE end_ts >= ? AND start_ts <= ? AND restored_at_ms IS NOT NULL ORDER BY start_ts ASC, sn ASC`,',
    to: '      WHERE end_ts >= ? AND start_ts <= ? ORDER BY start_ts ASC, sn ASC`, // MUTANT',
    why: 'A held span counts as restored: rows refused for a hold that a gate span also covers are re-captured.',
  },
  {
    id: 'H-xli. ★★ the repair is handed no restored spans',
    file: IDX,
    find: '      const r = heldLedgerRepair(y, { spans, coreSns, panelSn: shp2Sn, nowMs, horizonMs, restored });',
    to: '      const r = heldLedgerRepair(y, { spans, coreSns, panelSn: shp2Sn, nowMs, horizonMs }); void restored; /* MUTANT */',
    why: 'A row refused for a restored span stays "not scored — telemetry held" for good.',
  },
  // ── review round 6 ──
  {
    id: 'J-i. ★★★ a restore since the scan was planned is not looked for at the move',
    file: HS,
    find: '        .find((x) => !job.plannedRestored.some((p) => p.startMs === x.startMs) && continuesRestored(x, job.stretch));',
    to: '        .find(() => false); /* MUTANT */',
    why: 'The SQL restore needs no restart and a scan runs one step per tick: planned before it, the scan moves the rest of the hold under the span just marked restored, and those rows stay held for good under a span no reader treats as held.',
  },
  {
    id: 'J-ii. a stretch left for its restore at the move is counted as a held stretch',
    file: HS,
    find: '        if (job.fromMs === job.rangeFromMs) scanSpans--; // nothing of it moved: not a held stretch',
    to: '        /* MUTANT */',
    why: 'The scan\'s summary line says "1 held stretch(es), 0 row(s) moved" for a hold the owner had just restored.',
  },
  {
    id: 'J-iii. ★★★ a seeded clock past the stretch is held whenever it lies within an hour of its end',
    file: REC,
    find: '      if (clock != null && clock > startMs && (clock <= through || (!seededNotYetWritten.has(sn) && restatedSince(sn, through, heldValues)))) {',
    to: '      if (clock != null && clock > startMs && (clock <= through || restatedSince(sn, through, heldValues))) { /* MUTANT */',
    why: 'A Core back fresh for 15 min after a 40 h hold, dark again 25 min at the upgrade, is held from the hold\'s start and pushed as dark for 41 h.',
  },
  {
    id: 'J-iv. ★★ a seeded device\'s first write during the first scan is not remembered',
    file: REC,
    find: '          if (clockMs != null) returnedDuringScan.set(s.sn, { clockMs, atMs: now, mono: performance.now() });',
    to: '          /* MUTANT */',
    why: 'A Core back during the first scan after the upgrade gets no record and no warning for its 40 h hold: the sweep waited, and the write moved its clock on.',
  },
  {
    id: 'J-v. ★★ a remembered return is judged before the first scan has finished',
    file: REC,
    find: '      if (returnedDuringScan.size > 0 && (!heldScanScheduled || heldStore.isReady())) {',
    to: '      if (returnedDuringScan.size > 0) { /* MUTANT */',
    why: 'Judged from the held row the boot seeded, before the scan sets it back: a minute of darkness, nothing filed, and the entry is gone.',
  },
  {
    id: 'J-vi. ★ a remembered return keeps the held row it was seeded with',
    file: REC,
    find: '        if (back != null && back.clockMs > startMs && back.clockMs <= through) back.clockMs = startMs;',
    to: '        /* MUTANT */',
    why: 'A Core back before the scan\'s first move is judged from its last held row: nothing filed for the hold.',
  },
  {
    id: 'J-vii. ★ every remembered return is filed, however short its darkness',
    file: REC,
    find: '          if (darkMs > PER_DEVICE_GAP_THRESHOLD_MS) recordTelemetryGap(back.clockMs, Math.max(back.atMs, back.clockMs + darkMs), { sn });',
    to: '          recordTelemetryGap(back.clockMs, Math.max(back.atMs, back.clockMs + darkMs), { sn }); /* MUTANT */',
    why: 'Every Core that answers within the first scan after any restart gets a "Device telemetry gap" warning.',
  },
  {
    id: 'J-viii. a remembered return\'s record runs to when it was judged, not to the return',
    file: REC,
    find: '          if (darkMs > PER_DEVICE_GAP_THRESHOLD_MS) recordTelemetryGap(back.clockMs, Math.max(back.atMs, back.clockMs + darkMs), { sn });',
    to: '          if (darkMs > PER_DEVICE_GAP_THRESHOLD_MS) recordTelemetryGap(back.clockMs, Date.now(), { sn }); /* MUTANT */',
    why: 'The pushed window ends minutes after the Core was already back.',
  },
  {
    id: 'J-ix. ★★ the sweep looks a restored span up only for a device held from it in this process',
    file: REC,
    find: '          const restored = heldStore.restoredSpanFrom(sn, lastMs);',
    to: '          const restored = heldReplayFrom.get(sn)?.startMs === lastMs ? heldStore.restoredSpanFrom(sn, lastMs) : null; /* MUTANT */',
    why: 'After a restart between the move and the SQL restore, the Core is pushed as dark 6 h after the span\'s start, from it, while its restored rows run hours later.',
  },
  {
    id: 'J-x. ★★ the sweep releases a restored span\'s device even when its clock cannot move',
    file: REC,
    find: '            if ((lastInsertBySn.get(sn) ?? lastMs) > lastMs) continue;',
    to: '            continue; /* MUTANT */',
    why: 'A device whose span is marked restored with nothing back in samples is released on every sweep and never filed (survivor R3).',
  },
  {
    id: 'J-xi. ★★ a restore in a process booted after the move leaves the clock at the span\'s start',
    file: REC,
    find: '      if (newest > startMs) lastInsertBySn.set(sn, newest);',
    to: '      /* MUTANT */',
    why: 'The record is filed from the span\'s start, 3 h early, with a duration nothing measured.',
  },
  {
    id: 'J-xii. the clock a restore gives back is one series\' newest row, not the device\'s',
    file: REC,
    find: '      if (ts > newest) newest = ts;',
    to: '      if (newest === 0) newest = ts; /* MUTANT */',
    why: 'The record starts seconds before the device\'s last row in samples.',
  },
  {
    id: 'J-xiii. ★★ a seed inside a restored span from a record\'s start does not match the record',
    file: REC,
    find: '        ?? telemetryGapsLog.find((g) => g.sn === opts.sn && g.startMs < startMs && (startMs <= g.endMs || startMs <= restoredEndFrom(opts.sn!, g.startMs)))',
    to: '        ?? telemetryGapsLog.find((g) => g.sn === opts.sn && g.startMs < startMs && startMs <= g.endMs) /* MUTANT */',
    why: 'A replay restored after it ran past its record: the next boot files a second record with a new id, pushed, and Device Telemetry Gaps 24h reads 2.',
  },
  {
    id: 'J-xiv. ★★★ a held restatement is a home insert',
    file: REC,
    find: '        seededNotYetWritten.delete(s.sn); // v1.154.0 — its clock is in-process now, not seeded',
    to: '        seededNotYetWritten.delete(s.sn); if (!isBenchSpareSn(s.sn)) sawHomeInsert = true; /* MUTANT */',
    why: 'Replayed Cores keep the fleet clock current: with every home device held, each gets a per-device warning saying "other home devices kept reporting", and no fleet gap is filed.',
  },
  {
    id: 'J-xv. ★★ the fleet clock is not set back when every home device is held',
    file: REC,
    find: '    if (fleetClock < lastHomeInsertTs) lastHomeInsertTs = Math.max(fleetClock, firstHomeInsertWallMs);',
    to: '    /* MUTANT */',
    why: 'The fleet gap starts at the last replayed write before the scan, hours after the last fresh home reading.',
  },
  {
    id: 'J-xvi. ★ the fleet clock is set back past this process\'s first home write',
    file: REC,
    find: '    if (fleetClock < lastHomeInsertTs) lastHomeInsertTs = Math.max(fleetClock, firstHomeInsertWallMs);',
    to: '    if (fleetClock < lastHomeInsertTs) lastHomeInsertTs = fleetClock; /* MUTANT */',
    why: 'After a restart the in-process fleet gap starts before the boot, inside the restart\'s own record: the outage counted twice.',
  },
  {
    id: 'J-xvii. ★ a restore of one Core does not move the fleet clock forward',
    file: REC,
    find: '    if (lastHomeInsertTs > 0 && clock > lastHomeInsertTs && !isBenchSpareSn(sn)) lastHomeInsertTs = clock;',
    to: '    /* MUTANT */',
    why: 'Its restored rows are readings, yet its next write files a fleet gap from the last fresh home reading.',
  },
  {
    id: 'J-xviii. ★★ an evaluation that only restated a hold resets the silence',
    file: REC,
    find: '    if (samples.some((x) => !isBenchSpareSn(x.sn) && !heldReplayFrom.has(x.sn))) {',
    to: '    if (samples.some((x) => !isBenchSpareSn(x.sn))) { /* MUTANT */',
    why: 'The fleet gap of a fleet-wide replay names nothing held and is pushed as an MQTT/broker stall.',
  },
  {
    id: 'J-xix. ★ the replayed devices are not kept for what explains the silence',
    file: REC,
    find: '      for (const x of samples) if (!isBenchSpareSn(x.sn)) silenceReplayed.add(x.sn);',
    to: '      /* MUTANT */',
    why: 'The alert names the panel\'s shadow alone, or (no device held by the gate) blames a broker stall.',
  },
  {
    id: 'J-xx. ★ with no device held by the gate, the replayed ones explain nothing',
    file: REC,
    find: '    if (silenceHeld.size + silenceReplayed.size === 0 || Math.max(silenceEvalGapMs, nowMs - silenceEvalAtMs) > SILENCE_EVAL_MAX_GAP_MS) return undefined;',
    to: '    if (silenceHeld.size === 0 || Math.max(silenceEvalGapMs, nowMs - silenceEvalAtMs) > SILENCE_EVAL_MAX_GAP_MS) return undefined; /* MUTANT */',
    why: 'Two replayed Cores with no panel: the fleet gap is pushed as an MQTT/broker stall.',
  },
  {
    id: 'J-xxi. ★ a replayed Core is named as read with nothing measurable',
    file: REC,
    find: '[...silenceUnmeasured].filter((sn) => !silenceHeld.has(sn) && !silenceReplayed.has(sn)).sort(bySn);',
    to: '[...silenceUnmeasured].filter((sn) => !silenceHeld.has(sn)).sort(bySn); /* MUTANT */',
    why: 'The alert says "no home device it had a reading for gave one to record" and that the Cores reported nothing measurable.',
  },
  {
    id: 'J-xxii. the gap line does not say a device restated readings the scan moved',
    file: REC,
    find: "h.shadow ? 'cloud shadow' : h.replayed ? 'restating readings the held-sample scan moved' : 'no fresh content'",
    to: "h.shadow ? 'cloud shadow' : 'no fresh content' /* MUTANT */",
    why: 'The log says a replayed Core had no fresh content, which its content clock contradicts.',
  },
  {
    id: 'J-xxiii. ★ the alert leaves out a replayed Core',
    file: AL,
    find: "  if (replayed.length > 0) parts.push(`${list(replayed)} only restated ${replayed.length > 1 ? 'their' : 'its'} last readings, which the hourly check moved out of the history as held samples`);",
    to: '  /* MUTANT */',
    why: 'The pushed alert leaves out the Cores whose rows were written and then moved.',
  },
  {
    id: 'J-xxiv. a replayed Core is also phrased as sending no new readings',
    file: AL,
    find: '  const stale = held.filter((h) => !h.shadow && h.replayed !== true).map((h) => nameOf(h.sn));',
    to: '  const stale = held.filter((h) => !h.shadow).map((h) => nameOf(h.sn)); /* MUTANT */',
    why: 'Each replayed Core is named twice, once as sending nothing.',
  },
  {
    id: 'J-xxv. ★ the alert says nothing was recorded when replayed rows were',
    file: AL,
    find: "so ${held.some((h) => !h.shadow && h.replayed === true) ? 'no fresh reading was recorded (only fresh readings are kept)' : 'nothing was recorded (only fresh readings are saved)'}.",
    to: "so ${'nothing was recorded (only fresh readings are saved)'}. /* MUTANT */",
    why: 'The replayed rows were written and moved to held_samples: "nothing was recorded" is false.',
  },
  {
    id: 'J-xxvi. ★★ the restored side ignores what is still held (survivor L1)',
    file: NLS,
    find: '  const restored = sidesWhere(noted.pv && !held.pv && restoredIn(i.coreSns), noted.load && !held.load && restoredIn([i.panelSn]));',
    to: '  const restored = sidesWhere(noted.pv && restoredIn(i.coreSns), noted.load && restoredIn([i.panelSn])); /* MUTANT */',
    why: 'One of two held Cores restored: the row is reset and re-captured on every sweep for the whole horizon, the other Core still holding PV.',
  },
  {
    id: 'J-xxvii. ★ the PV side is matched against the panel\'s restored span too (survivor L2)',
    file: NLS,
    find: '  const restored = sidesWhere(noted.pv && !held.pv && restoredIn(i.coreSns), noted.load && !held.load && restoredIn([i.panelSn]));',
    to: '  const restored = sidesWhere(noted.pv && !held.pv && restoredIn([...i.coreSns, i.panelSn]), noted.load && !held.load && restoredIn([i.panelSn])); /* MUTANT */',
    why: 'A row refused for a Core no longer on the panel is reset once, its note saying the readings were restored.',
  },
  {
    id: 'J-xxviii. ★★ a restored span counts only when it lies inside the row\'s span (survivor L3)',
    file: NLS,
    find: '  const restoredIn = (sns: readonly string[]) => (i.restored ?? []).some((r) => sns.includes(r.sn) && overlapOf(r, span) > 0);',
    to: '  const restoredIn = (sns: readonly string[]) => (i.restored ?? []).some((r) => sns.includes(r.sn) && r.startMs >= span.startMs && r.endMs <= span.endMs); /* MUTANT */',
    why: 'The incident\'s 10-14 and 10-15 rows stay "not scored — telemetry held" with PV empty after their Core\'s span is restored.',
  },
  {
    id: 'J-xxix. ★★ a restored span counts only when it starts inside the row\'s span (survivor L4)',
    file: NLS,
    find: '  const restoredIn = (sns: readonly string[]) => (i.restored ?? []).some((r) => sns.includes(r.sn) && overlapOf(r, span) > 0);',
    to: '  const restoredIn = (sns: readonly string[]) => (i.restored ?? []).some((r) => sns.includes(r.sn) && r.startMs >= span.startMs && r.startMs < span.endMs); /* MUTANT */',
    why: 'The 10-15 row stays refused after the restore: the hold began the day before its issue.',
  },
  {
    id: 'J-xxx. ★ the repair does not say it reset a row (survivor I1)',
    file: IDX,
    find: '      reset = true;\n',
    to: '      /* MUTANT */\n',
    why: 'The sweep captures from the ledger as it read it before the reset: the reset row waits a whole tick uncaptured, and the evening readiness recompute reads it so.',
  },
  {
    id: 'J-xxxi. a write lock held elsewhere fails the whole scan, not the slice',
    file: HS,
    find: "    try {\n      // v1.188.1 (review 6) — IMMEDIATE: the write lock first, so the restored spans read below are\n      // the ones the copy and delete run against (another connection cannot commit in between). A\n      // lock held elsewhere fails this slice like any other step of it (below).\n      db.exec('BEGIN IMMEDIATE');",
    to: "    db.exec('BEGIN IMMEDIATE'); /* MUTANT */\n    try {",
    why: 'An SQL session left mid-transaction on the database aborts the scan (the rest of it, every other device, waits an hour) instead of failing one slice.',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs).
// fullSuite: false — the subset holds every test that guards these mutants, so a kill comes
// from the subset.
import { runMutantsParallel } from './lib/mutateParallel.mjs';
// typecheck: true — a mutant that does not compile is reported INVALID, never counted as a kill.
await runMutantsParallel({ name: 'mutate-v1188-1', mutants: MUTANTS, subset: SUBSET, root: REPO, fullSuite: false, typecheck: true });
