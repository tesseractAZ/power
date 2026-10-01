#!/usr/bin/env node
/**
 * mutate-v1187-1g.mjs — committed harness for v1.187.1 group G (the lows from the 2026-09-30 log
 * review): the cell-spread outlier's low side, the ghost pack slot across a restart, what a full
 * cleared-alert ledger drops first, the defective-pack retirement line, the boot-hold outcome
 * lines, and the offline wording for a device with no data this session.
 *
 * (1) alarms-live-2 — a cell spread LOWER than its siblings' is not a fault: info, annunciate:false
 *     (analytics.computeLearnedAlerts). Mutants i-v.
 * (2) general-1 — a hidden ghost slot is persisted (pack-ghosts.json) and an identical first reading
 *     after a restart keeps its time, so it is hidden on the first projection (packPresence.ts,
 *     snapshot.ts). Mutants vi-xxv.
 * (3) general-2 — cleared rows record `pushed` / `rosterMuted`; a full ledger drops old roster-muted
 *     rows, then unpushed noise, before annunciated history, and warranty evidence last
 *     (alertMonitor.pruneOldestNonSignificant / warrantyEvidence / clearedRetention). Mutants
 *     xxvi-xlvi.
 * (4) general-3 — the latch's retirement line goes through the monitor's warn sink with the record's
 *     identity (defectivePackLatch.ts). Mutants xlvii-li.
 * (5) general-4 — the boot holds name what they hold and log a drop once (broadcast.ts). Mutants
 *     lii-lxi.
 * (6) general-5 — a device with no data this session: no ">30 min", no cloud cause (alerts.ts).
 *     Mutants lxii-lxvii.
 *
 *   node scripts/mutate-v1187-1g.mjs
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
const AN = resolve(SERVER, 'src/analytics.ts');
const PP = resolve(SERVER, 'src/packPresence.ts');
const SNAP = resolve(SERVER, 'src/snapshot.ts');
const AM = resolve(SERVER, 'src/alertMonitor.ts');
const LATCH = resolve(SERVER, 'src/defectivePackLatch.ts');
const BC = resolve(SERVER, 'src/broadcast.ts');
const AL = resolve(SERVER, 'src/alerts.ts');

const SUBSET = [
  'test/peerSpreadLowSide.test.ts',
  'test/packGhostRestart.test.ts',
  'test/packPresence.test.ts',
  'test/clearedLedgerRetention.test.ts',
  'test/lifetimeHeadAndClearedRetention.test.ts',
  'test/defectivePackRetireLog.test.ts',
  'test/defectivePackLatch.test.ts',
  'test/broadcastBootHoldLog.test.ts',
  'test/offlineNoDataWording.test.ts',
  'test/v1187_1gWiring.test.ts',
];

const MUTANTS = [
  /* ── (1) the cell-spread outlier's low side ─────────────────────────── */
  {
    id: 'i. ★★★ the low side of a cell spread warns again',
    file: AN,
    find: '        const lowSpread = metric.key === \'voldiff\' && v < med;',
    to: '        const lowSpread = false; /* MUTANT */',
    why: 'The 09-30 card: the best-balanced pack of five carded a WARNING for being better balanced.',
  },
  {
    id: 'ii. ★★★ the low-side rule reaches SoC and SoH',
    file: AN,
    find: '        const lowSpread = metric.key === \'voldiff\' && v < med;',
    to: '        const lowSpread = v < med; /* MUTANT */',
    why: 'A pack far below its siblings\' SoC or SoH — a real signal — is muted.',
  },
  {
    id: 'iii. ★★★ the HIGH side is the one muted',
    file: AN,
    find: '        const lowSpread = metric.key === \'voldiff\' && v < med;',
    to: '        const lowSpread = metric.key === \'voldiff\' && v > med; /* MUTANT */',
    why: 'A pack diverging upward is neither pushed nor spoken.',
  },
  {
    id: 'iv. ★★★ the low side is still warning-eligible',
    file: AN,
    find: '        const warnEligible = isThermal ? v > med : !lowSpread;',
    to: '        const warnEligible = isThermal ? v > med : true; /* MUTANT */',
    why: 'A warning card that says it is not a fault.',
  },
  {
    id: 'v. ★★★ the low side annunciates',
    file: AN,
    find: '          ...(lowSpread ? { annunciate: false, muteReason: PEER_SPREAD_LOW_MUTE_REASON } : {}),',
    to: '          /* MUTANT */',
    why: 'Its benign short clears feed the auto-tune rollups and can help demote the high side.',
  },
  /* ── (2) the ghost slot across a restart ───────────────────────────── */
  {
    id: 'vi. ★★★ an identical first reading does not carry the ghost\'s time',
    file: PP,
    find: '    if (ghost != null && ghost.fp === fp) {',
    to: '    if (false) { /* MUTANT */',
    why: 'The 09-30 ghost: ~10 minutes of alerts and recorder samples for a pack that does not exist, after every restart.',
  },
  {
    id: 'vii. ★★★ any reading in the slot carries the ghost\'s time',
    file: PP,
    find: '    if (ghost != null && ghost.fp === fp) {',
    to: '    if (ghost != null) { /* MUTANT */',
    why: 'A pack put back in the slot is hidden at once under a stale count — from every alarm.',
  },
  {
    id: 'viii. ★★ a ghost dated after now is trusted',
    file: PP,
    find: '      hist.changedMs.set(p.num, Math.min(ghost.frozenSinceMs, nowMs));',
    to: '      hist.changedMs.set(p.num, ghost.frozenSinceMs); /* MUTANT */',
    why: 'After a backward clock step the ghost stays shown until the clock catches up.',
  },
  {
    id: 'ix. ★★ a carried observed change becomes a lower bound',
    file: PP,
    find: '      if (ghost.changeSeen) hist.changeSeen.add(p.num);',
    to: '      /* MUTANT */',
    why: 'The hide line after a restart says "or earlier" of a time it saw.',
  },
  {
    id: 'x. ★★ a first sighting is reported as an observed change',
    file: PP,
    find: '    if (prev != null) hist.changeSeen.add(p.num);',
    to: '    hist.changeSeen.add(p.num); /* MUTANT */',
    why: 'The v1.172.0 misdating: the boot instant printed as "frozen since".',
  },
  {
    id: 'xi. ★★ an observed change is reported as a first sighting',
    file: PP,
    find: '    if (prev != null) hist.changeSeen.add(p.num);',
    to: '    /* MUTANT */',
    why: 'A time the add-on saw is hedged as "or earlier".',
  },
  {
    id: 'xii. ★★ a ghost whose slot moves is not retired',
    file: PP,
    find: '    if (hist.ghosts.delete(p.num)) ghostsChanged = true;',
    to: '    /* MUTANT */',
    why: 'A re-inserted pack\'s old ghost stays on file for good.',
  },
  {
    id: 'xiii. ★★ a retired ghost is not saved',
    file: PP,
    find: '    if (hist.ghosts.delete(p.num)) ghostsChanged = true;',
    to: '    hist.ghosts.delete(p.num); /* MUTANT */',
    why: 'The file keeps a ghost the process has retired.',
  },
  {
    id: 'xiv. ★★ an unchanged ghost is re-saved on every projection',
    file: PP,
    find: '    if (hist.ghosts.get(d.num)?.frozenSinceMs === frozenSinceMs) continue;',
    to: '    /* MUTANT */',
    why: 'A file write on every ~1 Hz MQTT merge for every Core with a ghost.',
  },
  {
    id: 'xv. ★★★ a hidden slot is not recorded',
    file: PP,
    find: '    hist.ghosts.set(d.num, { fp: hist.fp.get(d.num)!, frozenSinceMs, changeSeen: hist.changeSeen.has(d.num) });',
    to: '    /* MUTANT */',
    why: 'Nothing is persisted: the ghost returns after every restart.',
  },
  {
    id: 'xvi. ★★ the file\'s slot is not validated',
    file: PP,
    find: '      if (!Number.isInteger(slot) || slot < 1 || g == null || typeof g !== \'object\') continue;',
    to: '      if (g == null || typeof g !== \'object\') continue; /* MUTANT */',
    why: 'A malformed key becomes a slot.',
  },
  {
    id: 'xvii. ★★ the file\'s fingerprint is not validated',
    file: PP,
    find: '      if (typeof g.fp !== \'string\' || g.fp.length === 0) continue;',
    to: '      /* MUTANT */',
    why: 'A non-string fingerprint is carried.',
  },
  {
    id: 'xviii. ★★ the file\'s time is not validated',
    file: PP,
    find: '      if (typeof g.frozenSinceMs !== \'number\' || !Number.isFinite(g.frozenSinceMs)) continue;',
    to: '      /* MUTANT */',
    why: 'A non-numeric time is carried into the hide rule.',
  },
  {
    id: 'xix. ★★ the file\'s change flag is not validated',
    file: PP,
    find: '      if (typeof g.changeSeen !== \'boolean\') continue;',
    to: '      /* MUTANT */',
    why: 'A malformed entry is carried.',
  },
  {
    id: 'xx. ★ a Core with no valid entry is kept',
    file: PP,
    find: '    if (m.size > 0) out.set(sn, m);',
    to: '    out.set(sn, m); /* MUTANT */',
    why: 'Empty entries are written back for good.',
  },
  {
    id: 'xxi. ★★ the hide line drops the lower-bound wording',
    file: PP,
    find: '  return `readings unchanged since ${new Date(d.frozenSinceMs).toISOString()}${d.changeSeen ? \'\' : \' or earlier\'}`;',
    to: '  return `readings unchanged since ${new Date(d.frozenSinceMs).toISOString()}`; /* MUTANT */',
    why: 'A first sighting reads as the freeze\'s date (the v1.172.0 misdating).',
  },
  {
    id: 'xxii. ★★★ the store builds a Core\'s history without the file\'s ghosts',
    file: SNAP,
    find: '    if (!hist) { hist = freshPackSlotHistory(this.packGhostsOnDisk.get(sn)); this.packHist.set(sn, hist); }',
    to: '    if (!hist) { hist = freshPackSlotHistory(); this.packHist.set(sn, hist); } /* MUTANT */',
    why: 'The file is written but never read: the ghost returns after every restart.',
  },
  {
    id: 'xxiii. ★★ a failed save is not retried',
    file: SNAP,
    find: '    if (r.ghostsChanged || this.packGhostsDirty) this.writePackGhosts();',
    to: '    if (r.ghostsChanged) this.writePackGhosts(); /* MUTANT */',
    why: 'One failed write (a full disk at the hide) loses the ghost until it next changes.',
  },
  {
    id: 'xxiv. ★★ a failed save is not marked for retry',
    file: SNAP,
    find: '      this.packGhostsDirty = true;',
    to: '      /* MUTANT */',
    why: 'As xxiii.',
  },
  {
    id: 'xxv. ★★ another Core\'s ghosts are dropped from the file',
    file: SNAP,
    find: '    for (const [sn, ghosts] of this.packGhostsOnDisk) if (!this.packHist.has(sn)) out[sn] = Object.fromEntries(ghosts);',
    to: '    /* MUTANT */',
    why: 'A Core not projected yet (cloud-dark at the restart) loses its ghost when another Core writes.',
  },
  {
    id: 'xxv-b. ★ the file is written outside the add-on without PACK_GHOSTS_PATH',
    file: SNAP,
    find: '      ?? (process.env.SUPERVISOR_TOKEN ? resolve(process.cwd(), config.dbPath, \'..\', \'pack-ghosts.json\') : \'\');',
    to: '      ?? resolve(process.cwd(), config.dbPath, \'..\', \'pack-ghosts.json\'); /* MUTANT */',
    why: 'One test process\'s ghosts are read by another\'s store.',
  },
  {
    id: 'xxv-c. ★★ the hide line prints the boot instant as "frozen since" again',
    file: SNAP,
    find: 'slot ${d.num} has ${packFrozenPhrase(d)} (a removed',
    to: 'slot ${d.num} has readings frozen since ${new Date(d.frozenSinceMs).toISOString()} /* MUTANT */ (a removed',
    why: 'The 09-30 line dated the freeze to the restart.',
  },
  /* ── (3) the full ledger ───────────────────────────────────────────── */
  {
    id: 'xxvi. ★★★ roster-muted rows get no early tier',
    file: AM,
    find: '  if (evictOldest((e, i) => sev(i) === \'warning\' && e.rosterMuted === true',
    to: '  if (evictOldest((e, i) => false && e.rosterMuted === true /* MUTANT */',
    why: 'Old bench-spare rows keep pushing out 82-day-old annunciated history.',
  },
  {
    id: 'xxvii. ★★★ the roster tier ignores the row\'s age',
    file: AM,
    find: '    && nowMs - e.clearedAt > CLEARED_ROSTER_MUTED_KEEP_MS && !evidence(e))) return;',
    to: '    && !evidence(e))) return; /* MUTANT */',
    why: 'At the cap every new bench-spare row is dropped on arrival: the record a going-bad spare builds is lost.',
  },
  {
    id: 'xxviii. ★★ the roster tier\'s age bound is inclusive',
    file: AM,
    find: '    && nowMs - e.clearedAt > CLEARED_ROSTER_MUTED_KEEP_MS && !evidence(e))) return;',
    to: '    && nowMs - e.clearedAt >= CLEARED_ROSTER_MUTED_KEEP_MS && !evidence(e))) return; /* MUTANT */',
    why: 'A row exactly at the bound leaves early.',
  },
  {
    id: 'xxix. ★★★ the roster tier takes warranty evidence',
    file: AM,
    find: '    && nowMs - e.clearedAt > CLEARED_ROSTER_MUTED_KEEP_MS && !evidence(e))) return;',
    to: '    && nowMs - e.clearedAt > CLEARED_ROSTER_MUTED_KEEP_MS)) return; /* MUTANT */',
    why: 'The muted bench rows of a defective pack\'s Core — the RMA record — leave first.',
  },
  {
    id: 'xxx. ★★ a roster-muted critical leaves early',
    file: AM,
    find: '  if (evictOldest((e, i) => sev(i) === \'warning\' && e.rosterMuted === true',
    to: '  if (evictOldest((e, i) => e.rosterMuted === true /* MUTANT */',
    why: 'A critical is evicted while warnings remain.',
  },
  {
    id: 'xxxi. ★★★ the unpushed-noise tier is removed',
    file: AM,
    find: '    if (evictOldest((e, i) => sev(i) === \'warning\' && isNoise(e) && e.pushed === false && !evidence(e))) return;',
    to: '    /* MUTANT */',
    why: 'A noise family\'s PUSHED episodes leave before its short clears that never reached the phone.',
  },
  {
    id: 'xxxii. ★★ a legacy row (push unknown) counts as unpushed',
    file: AM,
    find: '    if (evictOldest((e, i) => sev(i) === \'warning\' && isNoise(e) && e.pushed === false && !evidence(e))) return;',
    to: '    if (evictOldest((e, i) => sev(i) === \'warning\' && isNoise(e) && e.pushed !== true && !evidence(e))) return; /* MUTANT */',
    why: 'Rows written before the field existed, pushed or not, leave as if never pushed.',
  },
  {
    id: 'xxxiii. ★★★ the unpushed-noise tier takes warranty evidence',
    file: AM,
    find: '    if (evictOldest((e, i) => sev(i) === \'warning\' && isNoise(e) && e.pushed === false && !evidence(e))) return;',
    to: '    if (evictOldest((e, i) => sev(i) === \'warning\' && isNoise(e) && e.pushed === false)) return; /* MUTANT */',
    why: 'A noise-flagged pack-defective row leaves first.',
  },
  {
    id: 'xxxiv. ★★★ the noise tier takes warranty evidence',
    file: AM,
    find: '    if (evictOldest((e, i) => sev(i) === \'warning\' && isNoise(e) && !evidence(e))) return;',
    to: '    if (evictOldest((e, i) => sev(i) === \'warning\' && isNoise(e))) return; /* MUTANT */',
    why: 'As xxxiii.',
  },
  {
    id: 'xxxv. ★★★ pack-defective rows leave with the other warnings',
    file: AM,
    find: '  if (evictOldest((e, i) => sev(i) === \'warning\' && !isNeverMutedAlert(e.alert))) return;',
    to: '  if (evictOldest((e, i) => sev(i) === \'warning\')) return; /* MUTANT */',
    why: 'The RMA\'d pack\'s seven pack-defective rows were 738 warnings from the front of the queue.',
  },
  {
    id: 'xxxvi. ★★ warranty evidence forgets the pack\'s serial',
    file: AM,
    find: '    if (e.alert.sourcePackSn) packSns.add(e.alert.sourcePackSn);',
    to: '    /* MUTANT */',
    why: 'The pack\'s rows in another Core (the ?packSn= export) are not protected.',
  },
  {
    id: 'xxxvii. ★★ warranty evidence keys the Core on "<core>-<pk>"',
    file: AM,
    find: '    windows.push({ coreSn: rest.slice(0, rest.lastIndexOf(\'-\')), raisedAt: e.raisedAt, clearedAt: e.clearedAt });',
    to: '    windows.push({ coreSn: rest, raisedAt: e.raisedAt, clearedAt: e.clearedAt }); /* MUTANT */',
    why: 'No Core-level row (ems-volt, dpu-imbalance) is recognised as evidence.',
  },
  {
    id: 'xxxviii. ★★ warranty evidence misses a row that begins as the episode ends',
    file: AM,
    find: '      && e.raisedAt <= w.clearedAt && e.clearedAt >= w.raisedAt);',
    to: '      && e.raisedAt < w.clearedAt && e.clearedAt >= w.raisedAt); /* MUTANT */',
    why: 'An overlap at the boundary is dropped.',
  },
  {
    id: 'xxxix. ★★ warranty evidence misses a row that ends as the episode begins',
    file: AM,
    find: '      && e.raisedAt <= w.clearedAt && e.clearedAt >= w.raisedAt);',
    to: '      && e.raisedAt <= w.clearedAt && e.clearedAt > w.raisedAt); /* MUTANT */',
    why: 'As xxxviii, at the other end.',
  },
  {
    id: 'xl. ★★ warranty evidence ignores sourceSn',
    file: AM,
    find: '    return windows.some((w) => (id.includes(w.coreSn) || e.alert?.sourceSn === w.coreSn)',
    to: '    return windows.some((w) => (id.includes(w.coreSn)) /* MUTANT */',
    why: 'A row that names its Core only in sourceSn (as the export matches it) is not protected.',
  },
  {
    id: 'xli. ★★★ a pushed row is stamped roster-muted',
    file: AM,
    find: '  const rosterMuted = !pushed && t.annunciated !== true && mutedSns.some((sn) => t.alert.id.includes(sn));',
    to: '  const rosterMuted = t.annunciated !== true && mutedSns.some((sn) => t.alert.id.includes(sn)); /* MUTANT */',
    why: 'An episode pushed before a restart, then muted by the roster, leaves early.',
  },
  {
    id: 'xlii. ★★★ an episode that annunciated is stamped roster-muted',
    file: AM,
    find: '  const rosterMuted = !pushed && t.annunciated !== true && mutedSns.some((sn) => t.alert.id.includes(sn));',
    to: '  const rosterMuted = !pushed && mutedSns.some((sn) => t.alert.id.includes(sn)); /* MUTANT */',
    why: 'A warning spoken while its Core was on the panel leaves early once the Core is off it.',
  },
  {
    id: 'xliii. ★★★ a condition-muted row is stamped roster-muted',
    file: AM,
    find: '  const rosterMuted = !pushed && t.annunciated !== true && mutedSns.some((sn) => t.alert.id.includes(sn));',
    to: '  const rosterMuted = !pushed && t.annunciated !== true; /* MUTANT */',
    why: 'A home pack muted while balancing — the record of whether a mute hid a fault — leaves early.',
  },
  {
    id: 'xliv. ★★ nothing is recorded as pushed',
    file: AM,
    find: '  const pushed = t.pushSent === true;',
    to: '  const pushed = false; /* MUTANT */',
    why: 'Every noise row is "unpushed": the pushed ones leave first again.',
  },
  {
    id: 'xlv. ★★★ the monitor stamps nothing on the cleared row',
    file: AM,
    find: '          ...clearedRetention(t, muted),',
    to: '          /* MUTANT */',
    why: 'The tiers have nothing to read: the ledger stays FIFO.',
  },
  {
    id: 'xlv-b. ★★ the monitor stamps without the roster',
    file: AM,
    find: '          ...clearedRetention(t, muted),',
    to: '          ...clearedRetention(t, []), /* MUTANT */',
    why: 'No row is ever roster-muted.',
  },
  {
    id: 'xlvi. ★★★ the monitor never records that an episode annunciated',
    file: AM,
    find: '      if (t != null && a.annunciate !== false) t.annunciated = true;',
    to: '      /* MUTANT */',
    why: 'Every muted-at-clear row on an off-panel Core leaves early, though it was spoken.',
  },
  /* ── (4) the retirement line ───────────────────────────────────────── */
  {
    id: 'xlvii. ★★★ the monitor does not wire its warn sink',
    file: AM,
    find: '  setDefectivePackRetireLog(warn);',
    to: '  /* MUTANT */',
    why: 'The 09-29 retirement: an untimestamped stderr line no JSON or level triage sees.',
  },
  {
    id: 'xlviii. ★★ the monitor wires its info sink',
    file: AM,
    find: '  setDefectivePackRetireLog(warn);',
    to: '  setDefectivePackRetireLog(log); /* MUTANT */',
    why: 'A deleted warranty diagnosis below level 40.',
  },
  {
    id: 'xlix. ★★★ the latch logs to bare stderr again',
    file: LATCH,
    find: '      retireWarn(defectivePackRetiredLine(rec, hostEvaluable));',
    to: '      console.warn(`defective-pack: RETIRING confirmed record ${JSON.stringify(rec)}`); /* MUTANT */',
    why: 'As xlvii.',
  },
  {
    id: 'l. ★★ the line says absence for a backstop retirement',
    file: LATCH,
    find: '  const why = hostEvaluable',
    to: '  const why = true /* MUTANT */',
    why: 'A record retired because its chassis went dark for 90 days reads as a pack seen to leave.',
  },
  {
    id: 'li. ★★ the line drops the record\'s identity in words',
    file: LATCH,
    find: ' (${rec.deviceName} pack ${rec.packNum}, chassis ${rec.deviceSn}, confirmed ${new Date(rec.confirmedAtMs).toISOString()})',
    to: ' /* MUTANT */',
    why: 'Which pack, in which Core, confirmed when, only inside a JSON blob.',
  },
  /* ── (5) the boot holds ────────────────────────────────────────────── */
  {
    id: 'lii. ★★★ the yellow hold line names nothing',
    file: BC,
    find: 'startup transients clear on their own (${warningFingerprints.map(describeFingerprint).join(\'; \')})`);',
    to: 'startup transients clear on their own`); /* MUTANT */',
    why: 'The 09-30 06:32:58 line: what the boot yellow was could not be read from the log.',
  },
  {
    id: 'liii. ★★ the red hold line names nothing',
    file: BC,
    find: '(warm-up phantom guard) (${criticalFingerprints.map(describeFingerprint).join(\'; \')})`);',
    to: '(warm-up phantom guard)`); /* MUTANT */',
    why: 'As lii, for the red.',
  },
  {
    id: 'liv. ★★★ a dropped boot yellow leaves no line',
    file: BC,
    find: '    if (level !== \'yellow\' && bootYellowHold != null) {',
    to: '    if (false) { /* MUTANT */',
    why: 'Whether the boot yellow was spoken can only be inferred from missing lines.',
  },
  {
    id: 'lv. ★★ a rise to red is reported as a dropped yellow',
    file: BC,
    find: '      if (level === \'green\') log(`broadcast: boot yellow dropped',
    to: '      if (true /* MUTANT */) log(`broadcast: boot yellow dropped',
    why: 'A yellow that became a spoken red reads as never spoken.',
  },
  {
    id: 'lvi. ★★ the dropped-yellow line repeats every tick',
    file: BC,
    find: '      bootYellowHold = null;\n    }',
    to: '      /* MUTANT */\n    }',
    why: 'One line per green tick for the rest of the warm-up.',
  },
  {
    id: 'lvii. ★★ the yellow hold forgets warnings that joined it',
    file: BC,
    find: '      for (const f of warningFingerprints) bootYellowHold.fps.add(f);',
    to: '      /* MUTANT */',
    why: 'The drop line names nothing that was held.',
  },
  {
    id: 'lviii. ★★★ a dropped boot red leaves no line',
    file: BC,
    find: '    if (level !== \'red\' && bootRedHold != null) {',
    to: '    if (false) { /* MUTANT */',
    why: 'As liv, for the red.',
  },
  {
    id: 'lviii-b. ★★ the dropped-red line repeats every tick',
    file: BC,
    find: '      bootRedHold = null;\n    }',
    to: '      /* MUTANT */\n    }',
    why: 'One line per tick below red for the rest of the warm-up.',
  },
  {
    id: 'lix. ★★ the red hold is not recorded',
    file: BC,
    find: '      bootRedHold = { fps: [...criticalFingerprints] };',
    to: '      /* MUTANT */',
    why: 'As lviii.',
  },
  {
    id: 'lx. ★★ a spoken boot yellow is later reported as dropped',
    file: BC,
    find: '    bootYellowHold = null;\n    bootRedHold = null;',
    to: '    /* MUTANT */\n    bootRedHold = null;',
    why: 'A confirmed and spoken yellow that clears later reads as never spoken.',
  },
  {
    id: 'lxi. ★★ a spoken boot red is later reported as dropped',
    file: BC,
    find: '    bootYellowHold = null;\n    bootRedHold = null;',
    to: '    bootYellowHold = null;\n    /* MUTANT */',
    why: 'As lx, for the red.',
  },
  /* ── (6) no data this session ──────────────────────────────────────── */
  {
    id: 'lxii. ★★★ no data this session reads as ">30 min, lost its cloud connection" again',
    file: AL,
    find: '      let hint = !(lastDataAt > 0)',
    to: '      let hint = false /* MUTANT */',
    why: 'The 09-30 text three seconds after start-up — and on a pushed warning for a Core that dropped before a restart.',
  },
  {
    id: 'lxiii. ★★ a transition seen this session is ignored',
    file: AL,
    find: '        ? (d.onlineChangedAtMs',
    to: '        ? (false /* MUTANT */',
    why: 'A Core seen going offline 12 minutes ago is described only from the first device list.',
  },
  {
    id: 'lxiv. ★★ the listing age is dropped',
    file: AL,
    find: '${listedAt != null ? ` (${fmtAge(now - listedAt)} ago)` : \'\'}',
    to: '/* MUTANT */',
    why: 'How long it has been listed offline is not said.',
  },
  {
    id: 'lxv. ★★ the listing time is never read',
    file: AL,
    find: '      const listedAt = conn?.firstListedAtMs ?? null;',
    to: '      const listedAt = null; /* MUTANT */',
    why: 'As lxiv.',
  },
  {
    id: 'lxvi. ★★ the detail says "no telemetry" of a device that reported over REST',
    file: AL,
    find: ': lastDataAt > 0 ? `Last data ${fmtAge(now - lastDataAt)} ago via ${lastSource.toUpperCase()}.` : \'It has not reported since the add-on started.\'}${hint}`,',
    to: ': \'No telemetry received this session.\'}${hint}`, /* MUTANT */',
    why: 'The pre-v1.187.1 sentence, false for REST data.',
  },
  {
    id: 'lxvii. ★★ the monitor does not pass the listing time',
    file: AM,
    find: '        firstListedAtMs: store.firstListedAt(d.sn),',
    to: '        /* MUTANT */',
    why: 'As lxiv, in production.',
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
console.log(`mutate-v1187-1g: ${MUTANTS.length} mutants against ${SUBSET.join(' + ')}\n`);

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
