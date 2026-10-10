#!/usr/bin/env node
/**
 * mutate-v1187-10-g4.mjs — committed harness for v1.187.10 group g4 (log review 10-03:
 * telemetry, logging, forecast).
 *
 *   C8   the degradation window comes from the configured retention (120-365 days), so a plausible
 *        linear fade can reach 'projecting' (a fixed 30 days made it unreachable)        D-i..D-iii
 *   NWS  the storm-alert client logs its transitions through the monitor's sinks, and a carried
 *        last-good feed is UNKNOWN on the alarm path past NWS_ALERTS_MAX_CARRY_MS     N-i..N-xiii
 *   C9   an unchanged fleet-status tick emits a compact line (MQTT devices only)       F-i..F-ii
 *   C10  quota-failure breadcrumbs per episode and code, with a recovery line         Q-i..Q-v
 *   C19  the poll's failure set as a delta (warn = new failures outside the standing set) P-i..P-vi
 *   C20  the MPPT drift card is a W ÷ V·A reading-consistency check                    R-i
 *   C21  /api/health pollErrorKind is null while healthy                              H-i..H-ii
 *   C30  the GHI tick logs "nothing new" at most every 6 h, not every tick             G-i..G-iv
 *   C31  the first-sight line uses the resolved name; the pre-warm names its language   L-i..L-ii
 *   C32  request logging off through a LogController (no FSTDEP023)                    W-i
 *   C33  no device serial in a phone push (title, message, tag)                        S-i..S-iv
 *
 * Not mutated: the startPollLoop wiring createFleetStatusDumper(store, log, debug) (a level, not an
 * emission: the compact line is pinned through createFleetStatusDumper itself); the worker's copy of
 * RECORDER_RETENTION_DAYS (process.env at spawn — pinned end to end by degradationWindow.test.ts with
 * a real worker, there is no line to mutate).
 *
 *   node scripts/mutate-v1187-10-g4.mjs
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
const NW = resolve(SERVER, 'src/nws.ts');
const AM = resolve(SERVER, 'src/alertMonitor.ts');
const SNAP = resolve(SERVER, 'src/snapshot.ts');
const RI = resolve(SERVER, 'src/repairIssues.ts');
const TB = resolve(SERVER, 'src/telemetryBlind.ts');
const IDX = resolve(SERVER, 'src/index.ts');
const WE = resolve(SERVER, 'src/weather.ts');
const LH = resolve(SERVER, 'src/logHooks.ts');
const NO = resolve(SERVER, 'src/notify.ts');
const AR = resolve(SERVER, 'src/audioRenderer.ts');

const SUBSET = [
  'test/degradationWindow.test.ts',
  'test/stormPrepUnknownFeed.test.ts',
  'test/nwsAlertsTransitions.test.ts',
  'test/fleetStatusCompact.test.ts',
  'test/logReachAndDisplayHonesty.test.ts',
  'test/pollFailureDeltas.test.ts',
  'test/repairIssues.test.ts',
  'test/healthPollErrorKind.test.ts',
  'test/ghiTickLog.test.ts',
  'test/firstSightName.test.ts',
  'test/audioRendererBilingual.test.ts',
  'test/fastifyRequestLogging.test.ts',
  'test/pushSerialMask.test.ts',
];

const MUTANTS = [
  // ── C8 — the degradation window ──────────────────────────────────────────────────────────────
  {
    id: 'D-i. ★★★ the window is a fixed 30 days again',
    file: AN,
    find: '  const windowDays = degradationWindowDays(resolveRetentionDays(process.env.RECORDER_RETENTION_DAYS));\n  const since = now - windowDays * 86_400_000;',
    to: '  const windowDays = degradationWindowDays(resolveRetentionDays(process.env.RECORDER_RETENTION_DAYS));\n  const since = now - 30 * 86_400_000; /* MUTANT */',
    why: 'THE DEFECT: no linear fade passes both the 1.5-pt floor and the 10 %/yr ceiling; the dated EOL is unknown for good.',
  },
  {
    id: 'D-ii. ★★ the window ignores the configured retention',
    file: AN,
    find: '  return Math.min(DEGRADE_WINDOW_MAX_DAYS, Math.max(DEGRADE_WINDOW_MIN_DAYS, Math.round(retentionDays)));',
    to: '  return DEGRADE_WINDOW_MIN_DAYS; /* MUTANT */',
    why: 'Slow (2-5 %/yr) fades are never dated however much history the retention keeps.',
  },
  {
    id: 'D-iii. ★★ the window is not capped',
    file: AN,
    find: '  return Math.min(DEGRADE_WINDOW_MAX_DAYS, Math.max(DEGRADE_WINDOW_MIN_DAYS, Math.round(retentionDays)));',
    to: '  return Math.max(DEGRADE_WINDOW_MIN_DAYS, Math.round(retentionDays)); /* MUTANT */',
    why: 'A five-year retention scans five years of three pack metrics per pack every 30 minutes.',
  },
  // ── NWS — carry limit and transitions ────────────────────────────────────────────────────────
  {
    id: 'N-i. ★★★ no carry limit: a stale last-good feed reads as current for ever',
    file: NW,
    find: '  if (feed != null && nwsAlertsCarryExpired(feed.fetchedAt, Date.now(), maxCarryMs)) {',
    to: '  if (false) { /* MUTANT */',
    why: 'THE DEFECT: through an outage that began after a boot, storm alerts are built from an hours-old feed and the storm-prep feed reads fresh.',
  },
  {
    id: 'N-ii. ★★ the limit is inclusive',
    file: NW,
    find: '  return fetchedAtMs != null && nowMs - fetchedAtMs > maxCarryMs;',
    to: '  return fetchedAtMs != null && nowMs - fetchedAtMs >= maxCarryMs; /* MUTANT */',
    why: 'The boundary moves: a feed exactly at the limit is already unknown.',
  },
  {
    id: 'N-iii. ★★ the display route applies the alarm path\'s limit',
    file: AN,
    find: '  const feed = await getNwsAlerts({ maxCarryMs: Infinity });',
    to: '  const feed = await getNwsAlerts(); /* MUTANT */',
    why: '/api/nws-alerts and the calendar drop a warning that is still in effect when the fetch fails for an hour.',
  },
  {
    id: 'N-iv. ★★★ an answer built from a carried feed is cached',
    file: AN,
    find: '  if (!carried) stormPrepCache = { ts: Date.now(), value: out };',
    to: '  stormPrepCache = { ts: Date.now(), value: out }; /* MUTANT */',
    why: 'The pass that crosses the carry limit reads the 10-minute cache, so the stale feed is served up to 10 minutes past the limit.',
  },
  {
    id: 'N-iv-b. ★★ an EMPTY answer built from a carried feed is cached',
    file: AN,
    find: '    if (!carried) stormPrepCache = { ts: Date.now(), value: [] };',
    to: '    stormPrepCache = { ts: Date.now(), value: [] }; /* MUTANT */',
    why: 'As N-iv for a quiet sky: "no storms" is served up to 10 minutes past the carry limit.',
  },
  {
    id: 'N-v. ★★ no answer counts as carried',
    file: AN,
    find: '  const carried = Date.now() - feed.fetchedAt >= NWS_ALERTS_TTL_MS;',
    to: '  const carried = false; /* MUTANT */',
    why: 'As N-iv, for every answer.',
  },
  {
    id: 'N-vi. ★★ the carry WARNING repeats on every pass',
    file: NW,
    find: '    if (!alertsCarryWarned) {',
    to: '    if (true) { /* MUTANT */',
    why: 'A warn line every 20 s monitor pass for as long as NWS is down.',
  },
  {
    id: 'N-vii. ★★★ the carry limit is logged at info',
    file: NW,
    find: '      nwsWarn(\n',
    to: '      nwsInfo( /* MUTANT */\n',
    why: 'Storm alerts going UNKNOWN is not in the warn stream an operator scans.',
  },
  {
    id: 'N-viii. ★★ every unchanged answer logs',
    file: NW,
    find: '    } else if (key !== alertsEventsKey) {',
    to: '    } else if (true) { /* MUTANT */',
    why: 'A line every 15 min restating the same alerts: the cadence noise the review removed elsewhere.',
  },
  {
    id: 'N-ix. ★★ every failure in an outage logs',
    file: NW,
    find: '    if (alertsFailingSinceMs == null) {\n      alertsFailingSinceMs = alertsFailedAt;',
    to: '    if (true) { /* MUTANT */\n      alertsFailingSinceMs = alertsFailedAt;',
    why: 'A line every 2-minute backoff for as long as api.weather.gov fails.',
  },
  {
    id: 'N-x. ★★ a recovery does not close the outage',
    file: NW,
    find: '    alertsEventsKey = key;\n    alertsFailingSinceMs = null;',
    to: '    alertsEventsKey = key; /* MUTANT */',
    why: 'Every later success logs "recovered", and the next outage logs no first-failure line.',
  },
  {
    id: 'N-xi. ★★★ the fetch is given no logger',
    file: NW,
    find: '    : await alertsFlight.run(() => fetchNwsAlerts(nwsInfo));',
    to: '    : await alertsFlight.run(() => fetchNwsAlerts(() => {})); /* MUTANT */',
    why: 'THE DEFECT: no storm-alert fetch, failure or recovery ever reaches the journal.',
  },
  {
    id: 'N-xii. ★★★ the alert monitor does not install the NWS sinks',
    file: AM,
    find: '  setNwsLog(log, warn);',
    to: '  /* MUTANT */',
    why: 'THE DEFECT, in production: the client keeps its no-op default.',
  },
  {
    id: 'N-xiii. ★★ the storm-prep throw no longer fires past the carry limit',
    file: AN,
    find: "  if (feed == null) throw new Error('NWS alerts unknown — no successful fetch within the carry limit (the fetch failed and no current feed is cached)');",
    to: '  if (feed == null) return []; /* MUTANT */',
    why: 'Past the limit the storm alerts read "none": a warning in effect is cleared, not held.',
  },
  // ── C9 — fleet-status compact line ───────────────────────────────────────────────────────────
  {
    id: 'F-i. ★★★ an unchanged tick emits the full line again',
    file: SNAP,
    find: "  const line = level === 'info'",
    to: '  const line = true /* MUTANT */',
    why: 'THE DEFECT: 44.7 % of the journal restating one state vector at the standing LOG_LEVEL=debug.',
  },
  {
    id: 'F-ii. ★★ the compact line keeps the static entries',
    file: SNAP,
    find: "    if (status.startsWith('ON/')) compact.push(",
    to: '    if (true) compact.push( /* MUTANT */',
    why: 'The OFF and API-online/no-MQTT entries, which the signature proves unchanged, stay in every tick.',
  },
  // ── C10 — quota breadcrumbs per episode ──────────────────────────────────────────────────────
  {
    id: 'Q-i. ★★★ a success does not close the episode',
    file: SNAP,
    find: '            quotaErrOpen.delete(d.sn);',
    to: '            /* MUTANT */',
    why: 'A recovery line on every later poll, and a second episode with the same code logs no cause.',
  },
  {
    id: 'Q-ii. ★★★ every code says "presence only"',
    file: SNAP,
    find: " + (code === '1006'",
    to: ' + (true /* MUTANT */',
    why: 'THE DEFECT: a one-poll 1020 rate limit reads as a permanent product-class limit.',
  },
  {
    id: 'Q-iii. ★★ the alarm-path panel\'s cause is logged at info',
    file: SNAP,
    find: '            (alarmPath.has(d.sn) ? warn : log)(line);',
    to: '            log(line); /* MUTANT */',
    why: 'A rate-limited alarm-path panel (the input to the telemetry-blind critical) is not in the warn stream.',
  },
  {
    id: 'Q-iv. ★★ the episode is keyed on the serial only',
    file: SNAP,
    find: '          if (quotaErrOpen.get(d.sn) !== code) {',
    to: '          if (!quotaErrOpen.has(d.sn)) { /* MUTANT */',
    why: 'A device whose failure changes cause (1020 → timeout) mid-episode logs nothing about the new cause.',
  },
  {
    id: 'Q-v. ★★ the EcoFlow code is not parsed',
    file: SNAP,
    find: '  if (api) return api[1];',
    to: "  if (api) return 'error'; /* MUTANT */",
    why: 'Every vendor error reads "error": the 1006 standing set is no longer recognised, and the warn names no code.',
  },
  // ── C19 — the failure set as a delta ─────────────────────────────────────────────────────────
  {
    id: 'P-i. ★★★ nothing is standing: the 1006 set warns at every boot',
    file: SNAP,
    find: "  const isStanding = (sn: string) => o.failureCodes[sn] === '1006' && !o.alarmPathSns.has(sn);",
    to: '  const isStanding = (_sn: string) => false; /* MUTANT */',
    why: 'THE DEFECT: every restart restates the expected accessory set at warn.',
  },
  {
    id: 'P-ii. ★★★ the alarm-path panel can be standing',
    file: SNAP,
    find: "  const isStanding = (sn: string) => o.failureCodes[sn] === '1006' && !o.alarmPathSns.has(sn);",
    to: "  const isStanding = (sn: string) => o.failureCodes[sn] === '1006'; /* MUTANT */",
    why: 'Fail quiet: an alarm-path panel answering 1006 is filed as an expected accessory at info.',
  },
  {
    id: 'P-iii. ★★★ the whole set is "new" (the v1.86.0 set-change warn)',
    file: SNAP,
    find: '  const newly = o.failedSns.filter((sn) => !prev.has(sn));',
    to: '  const newly = [...o.failedSns]; /* MUTANT */',
    why: 'THE DEFECT: a growth restates every failing device, standing ones included.',
  },
  {
    id: 'P-iv. ★★ a device no longer asked counts as recovered',
    file: SNAP,
    find: '  const recovered = gone.filter((sn) => attempted.has(sn));',
    to: '  const recovered = gone; /* MUTANT */',
    why: 'A Core that went offline in the device list is logged as having answered again.',
  },
  {
    id: 'P-v. ★★ the poll loop passes no failure codes',
    file: SNAP,
    find: '          prevFailedSns: lastFailedSns, attemptedSns, failedSns, failureCodes: failureCodes ?? {},',
    to: '          prevFailedSns: lastFailedSns, attemptedSns, failedSns, failureCodes: {}, /* MUTANT */',
    why: 'The warn names no codes, and the standing 1006 set warns at every boot.',
  },
  {
    id: 'P-vi. ★★ the poll loop never records the previous set',
    file: SNAP,
    find: '        lastFailedSns = [...failedSns];',
    to: '        /* MUTANT */',
    why: 'Every poll with a failure warns it as new: a warn line a minute.',
  },
  // ── C20 — the MPPT drift card ───────────────────────────────────────────────────────────────
  {
    id: 'R-i. ★★ the card sends the operator to MC4 connectors again',
    file: RI,
    find: '            `Measure the ${s.string} string\'s voltage and current',
    to: '            `Inspect MC4 connectors on the ${s.string} string; /* MUTANT */ Measure the ${s.string} string\'s voltage and current',
    why: 'Hardware work prescribed for a reading-consistency ratio that connector losses cannot move.',
  },
  // ── C21 — pollErrorKind ─────────────────────────────────────────────────────────────────────
  {
    id: 'H-i. ★★ the class is published while healthy',
    file: TB,
    find: '  return v.blind || s.lastError != null || s.consecutiveFailures > 0 ? v.errorKind : null;',
    to: '  return v.errorKind; /* MUTANT */',
    why: 'THE DEFECT: a healthy add-on reports pollErrorKind "other".',
  },
  {
    id: 'H-ii. ★★ the route publishes the raw verdict class',
    file: IDX,
    find: '    pollErrorKind: healthPollErrorKind(blind, pollState()),',
    to: '    pollErrorKind: blind.errorKind, /* MUTANT */',
    why: 'As H-i, in the route.',
  },
  // ── C30 — the GHI tick line ─────────────────────────────────────────────────────────────────
  {
    id: 'G-i. ★★ a tick that wrote rows also says "nothing new"',
    file: WE,
    find: '    if (o.written + o.realized > 0) return; // the recorder logged the write itself',
    to: '    /* MUTANT */',
    why: 'A false "nothing new to store" beside the recorder\'s own write line.',
  },
  {
    id: 'G-ii. ★★★ the quiet line is emitted every tick',
    file: WE,
    find: '    if (lastQuietLineMs == null || nowMs - lastQuietLineMs >= heartbeatMs) {',
    to: '    if (true) { /* MUTANT */',
    why: 'THE DEFECT: a byte-identical line every 45 minutes.',
  },
  {
    id: 'G-iii. ★★ "no forecast" repeats every tick',
    file: WE,
    find: '      if (!noWeather) log(',
    to: '      log( /* MUTANT */',
    why: 'An outage of the weather fetch logs the same line every 45 minutes.',
  },
  {
    id: 'G-iv. ★★ the tick does not report a missing forecast',
    file: IDX,
    find: "        logGhiTick({ kind: 'no-weather' }, Date.now());",
    to: '        /* MUTANT */',
    why: 'A dead weather fetch leaves no trace from the tick (the old line hid it too).',
  },
  // ── C31 — boot line hygiene ─────────────────────────────────────────────────────────────────
  {
    id: 'L-i. ★★ first sight logs the raw cloud name',
    file: SNAP,
    find: "        this.logger(`device-list: ${displayName} (${d.sn}) first sight, ${newOnline ? 'online' : 'offline'}`);",
    to: "        this.logger(`device-list: ${d.deviceName ?? d.sn} (${d.sn}) first sight, ${newOnline ? 'online' : 'offline'}`); /* MUTANT */",
    why: 'A device listed under its serial prints the serial twice; a leading space is kept.',
  },
  {
    id: 'L-ii. ★ the pre-warm summary does not name its language',
    file: AR,
    find: '  opts.log(`audioRenderer: terminator pre-warm (${langs}) — ',
    to: '  opts.log(`audioRenderer: terminator pre-warm /* MUTANT */ — ',
    why: 'The Spanish and English summaries are byte-identical again.',
  },
  // ── C32 — request logging ───────────────────────────────────────────────────────────────────
  {
    id: 'W-i. ★★★ request logging is on',
    file: LH,
    find: '    logController: new LogController({ disableRequestLogging: true }),',
    to: '    logController: new LogController({ disableRequestLogging: false }), /* MUTANT */',
    why: 'Two lines per request: 78 % of journald volume when this was last on.',
  },
  // ── C33 — serials in a phone push ───────────────────────────────────────────────────────────
  {
    id: 'S-i. ★★ the push title and message carry full serials',
    file: NO,
    find: '  return { title: maskDeviceSerials(msg.title), message: maskDeviceSerials(msg.body), data };',
    to: '  return { title: msg.title, message: msg.body, data }; /* MUTANT */',
    why: 'Device serials leave the host through the phone push service.',
  },
  {
    id: 'S-ii. ★★ the push tag carries the serial',
    file: NO,
    find: '  const tag = haNotificationId(msg.dedupId != null ? maskSerialsInId(msg.dedupId) : undefined, msg.severity);',
    to: '  const tag = haNotificationId(msg.dedupId, msg.severity); /* MUTANT */',
    why: 'As S-i, through data.tag.',
  },
  {
    id: 'S-iii. ★★ any 16-character token is masked',
    file: NO,
    find: '  return digits >= 2 && tok.length - digits >= 2;',
    to: '  return true; /* MUTANT */',
    why: 'A 16-letter word or a 16-digit number in a push is mangled.',
  },
  {
    id: 'S-iv. ★ a lower-case token is masked in the text',
    file: NO,
    find: '(tok === tok.toUpperCase() && serialShaped(tok) ? packSnTail(tok) : tok)',
    to: '(serialShaped(tok) ? packSnTail(tok) : tok) /* MUTANT */',
    why: 'Words and ids that are not serials are cut to six characters.',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs);
// the verdict procedure per mutant (subset, then the full suite on a subset pass) is unchanged.
import { runMutantsParallel } from './lib/mutateParallel.mjs';
await runMutantsParallel({ name: 'mutate-v1187-10-g4', mutants: MUTANTS, subset: SUBSET, root: REPO });
