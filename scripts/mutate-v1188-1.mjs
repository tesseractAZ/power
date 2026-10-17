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
 *   B-i     the incomplete-basis note drops the held verdict (no marker)
 *   B-ii    the scorer writes the bare basis note on a held row
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
const SUBSET = [
  'test/recorderHeldReadings.test.ts',
  'test/heldSamplesBackfill.test.ts',
  'test/ledgerHeldTelemetry.test.ts',
  'test/recorderRestartGap.test.ts',
  'test/heldSamplesWorkerMemo.test.ts',
  'test/curtailmentHeldPanel.test.ts',
  'test/trendMergeGaps.test.ts',
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
    find: '  return d.contentStaleSinceMs == null;\n}',
    to: '  return true; /* MUTANT */\n}',
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
    id: 'S-iii. ★★ the seeded gap clock is not moved back after a move',
    file: REC,
    find: '      if (seededNotYetWritten.has(sn) && seed != null && seed > startMs && seed <= endMs) lastInsertBySn.set(sn, startMs);',
    to: '      void seed; /* MUTANT */',
    why: 'A Core still held at the deploy is measured from a held row that no longer exists: its gap is filed 6 h late, from the wrong start, and a later boot files a second record.',
  },
  {
    id: 'F-i. ★ the scanner needs no restatements',
    file: HS,
    find: '      const qualifies = observedMs >= opts.minSpanMs && restatements >= opts.minRestatements && counts.size >= opts.minMetrics;',
    to: '      const qualifies = observedMs >= opts.minSpanMs && counts.size >= opts.minMetrics; /* MUTANT */',
    why: 'Two identical rows an hour apart — a restart after an hour down — read as a hold.',
  },
  {
    id: 'F-ii. ★★ the scanner needs no metric count',
    file: HS,
    find: '      const qualifies = observedMs >= opts.minSpanMs && restatements >= opts.minRestatements && counts.size >= opts.minMetrics;',
    to: '      const qualifies = observedMs >= opts.minSpanMs && restatements >= opts.minRestatements; /* MUTANT */',
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
    find: '      const qualifies = observedMs >= opts.minSpanMs && restatements >= opts.minRestatements && counts.size >= opts.minMetrics;',
    to: '      const qualifies = restatements >= opts.minRestatements && counts.size >= opts.minMetrics; /* MUTANT */',
    why: 'Forty quiet minutes of a live Core are moved out of samples.',
  },
  {
    id: 'F-v. ★★ a known span\'s tail must qualify on its own',
    file: HS,
    find: '      if (!s.qualifies && prior == null) continue;',
    to: '      if (!s.qualifies) continue; /* MUTANT */',
    why: 'The newest 15 min of a hold, left by the first scan after the deploy, restate each metric only once or twice: they stay in samples, and the held Core\'s gap clock stays on a held row.',
  },
  {
    id: 'F-vi. ★★ every stretch is moved, qualifying or not',
    file: HS,
    find: '      if (!s.qualifies && prior == null) continue;',
    to: '      /* MUTANT */',
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
    find: '      if (restored.some((r) => overlapMs(r.startMs, r.endMs, s.startMs, s.endMs) > 0)) {',
    to: '      if (false) { /* MUTANT */',
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
    find: "  if (String(row.score_notes ?? '').toLowerCase().includes(HELD_TELEMETRY_MARKER)) return null;",
    to: '  /* MUTANT */',
    why: 'A re-captured row is reset again on every sweep: it never stays captured.',
  },
  {
    id: 'L-iv. the repair reads the full 24 h, not the span the row was captured over',
    file: NLS,
    find: '    span: { startMs: issued, endMs: Math.min(cap, issued + FORECAST_SPAN_MS) },',
    to: '    span: { startMs: issued, endMs: issued + FORECAST_SPAN_MS }, /* MUTANT */',
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
    find: '  const actualLoadKwh = loadPts.length && !(heldVerdict != null && heldVerdict.load.length > 0) ? round2(integrateWh(loadPts, false) / 1000) : null;',
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
    id: 'B-i. ★★★ the incomplete-basis note drops the held verdict',
    file: NLS,
    find: '  if (v == null) return BASIS_INCOMPLETE_NOTE;',
    to: '  if (v == null || Date.now() > 0) return BASIS_INCOMPLETE_NOTE; /* MUTANT */',
    why: 'No marker: the held repair resets and re-captures the row on every sweep for 28 days.',
  },
  {
    id: 'B-ii. ★★ the scorer writes the bare basis note on a held row',
    file: IDX,
    find: '    scoreNotes = basisIncompleteNote(heldVerdict, deviceNameOf);',
    to: '    scoreNotes = basisIncompleteNote(null, deviceNameOf); /* MUTANT */',
    why: 'The same endless reset, from the scorer.',
  },
  {
    id: 'O-i. ★★★ a gap with no rows counts toward a frozen stretch',
    file: HS,
    find: '          if (prevRowTs != null && ts - prevRowTs <= bridgeMs) observedMs += ts - prevRowTs;',
    to: '          if (prevRowTs != null) observedMs += ts - prevRowTs; /* MUTANT */',
    why: 'A constant Core back from a 55-min gap has its fresh rows moved after 10 min of observation, and its night refused.',
  },
  {
    id: 'O-ii. an interval of exactly the bridge is not observed constancy',
    file: HS,
    find: '          if (prevRowTs != null && ts - prevRowTs <= bridgeMs) observedMs += ts - prevRowTs;',
    to: '          if (prevRowTs != null && ts - prevRowTs < bridgeMs) observedMs += ts - prevRowTs; /* MUTANT */',
    why: 'Rows two heartbeats apart (integrateWh\'s own bridge) read as a gap.',
  },
  {
    id: 'O-iii. ★ observed constancy carries over from the previous stretch',
    file: HS,
    find: '    lastHeldTs = Number.NEGATIVE_INFINITY;\n    observedMs = 0;\n  };',
    to: '    lastHeldTs = Number.NEGATIVE_INFINITY;\n    /* MUTANT */\n  };',
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
    find: '    scanRows = 0;\n    failedFromMs = Number.POSITIVE_INFINITY;',
    to: '    scanRows = 0;\n    /* MUTANT */',
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
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs).
// fullSuite: false — the subset holds every test that guards these mutants, so a kill comes
// from the subset.
import { runMutantsParallel } from './lib/mutateParallel.mjs';
// typecheck: true — a mutant that does not compile is reported INVALID, never counted as a kill.
await runMutantsParallel({ name: 'mutate-v1188-1', mutants: MUTANTS, subset: SUBSET, root: REPO, fullSuite: false, typecheck: true });
