#!/usr/bin/env node
/**
 * mutate-v1187-a.mjs — committed harness for v1.187.0 group A (cell-spread alarms): the
 * end-of-charge knee grace on the vdiff critical and its bounds (ceiling, duration,
 * fail-to-relax, evidence — balancing vs the narrower stream-delivered charge input — and the
 * episode clock across dips and reading gaps), the never-muted cell-overvoltage critical, the
 * peer cell-spread outlier's top-of-charge audible gate and its yield to a held critical, and
 * the audible chain (speakableAlerts, the voiced primary, the push gate).
 *
 * Log review 09-29 (xlvi-lvii): both graces are bounded by the top-of-charge SESSION
 * (graceFromMs), not by the current crossing; after a restart a pack's clocks start from its
 * standing critical's persisted onset; and a critical is never boot-seeded without a delivery
 * record.
 *
 *   node scripts/mutate-v1187-a.mjs
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
const AN = resolve(SERVER, 'src/analytics.ts');
const BC = resolve(SERVER, 'src/broadcast.ts');
const AM = resolve(SERVER, 'src/alertMonitor.ts');
const SN = resolve(SERVER, 'src/snapshot.ts');
const TT = resolve(SERVER, 'src/ttsService.ts');

const SUBSET = [
  'test/cellSpreadEndOfChargeKnee.test.ts',
  'test/cellOvervoltageAlert.test.ts',
  'test/peerSpreadTopOfChargeAudible.test.ts',
  'test/peerSpreadYieldsToHeldCritical.test.ts',
  'test/imbalanceSpeakHold.test.ts',
  'test/alertVdiffBalancing.test.ts',
  'test/bootHydrationEdges.test.ts',
  'test/cellSpreadKneeRestart.test.ts',
];

const MUTANTS = [
  /* ── the vdiff-crit mute and its bounds ───────────────────────────────── */
  {
    id: 'i. ★★★ the critical is muted by balancing alone again (the knee mute is bypassed)',
    file: AL,
    find: '            ...(critMute ? { annunciate: false, mutedBy: critMute, muteReason: CELL_SPREAD_MUTE_TEXT[critMute] } : {}),',
    to: '            ...(balancing ? { annunciate: false } : {}), /* MUTANT */',
    why: 'The 2026-09-29 end-of-charge spreads sound the 72-second critical klaxon a minute after balancing stops.',
  },
  {
    id: 'ii. ★★★ no unconditional ceiling',
    file: AL,
    find: '  if (obs.spreadMv >= VOL_DIFF_KNEE_HARD_MV) return null;',
    to: '  /* MUTANT */',
    why: 'A 150+ mV spread stays silent while the BMS balances or the pack charges at top of charge.',
  },
  {
    id: 'iii. ★★★ balancing is checked before the ceiling',
    file: AL,
    find: '  if (obs.spreadMv >= VOL_DIFF_KNEE_HARD_MV) return null;',
    to: "  if (obs.balancing) return 'balancing'; /* MUTANT */\n  if (obs.spreadMv >= VOL_DIFF_KNEE_HARD_MV) return null;",
    why: 'The v0.29.0 balancing mute stays unbounded in spread: any imbalance is silent while the BMS balances.',
  },
  {
    id: 'iv. ★★★ no duration bound',
    file: AL,
    find: '  if (s.critSinceMs != null && nowMs - s.critSinceMs >= VDIFF_KNEE_MAX_MUTE_MS) return null;',
    to: '  /* MUTANT */',
    why: 'A spread the BMS keeps balancing at top of charge is silent indefinitely.',
  },
  {
    id: 'v. ★★ balancing is checked before the duration bound',
    file: AL,
    find: '  if (s.critSinceMs != null && nowMs - s.critSinceMs >= VDIFF_KNEE_MAX_MUTE_MS) return null;',
    to: "  if (obs.balancing) return 'balancing'; /* MUTANT */\n  if (s.critSinceMs != null && nowMs - s.critSinceMs >= VDIFF_KNEE_MAX_MUTE_MS) return null;",
    why: 'The duration bound never applies to the balancing mute, which is the unbounded one.',
  },
  {
    id: 'vi. ★★★ no fail-to-relax exit after balancing (the grace lasts as long as the evidence is remembered)',
    file: AL,
    find: '  if (s.lastBalancingMs != null && nowMs - s.lastBalancingMs < VDIFF_KNEE_RELAX_MS\n    && nowMs - s.graceFromMs < VDIFF_KNEE_MAX_MUTE_MS)',
    to: '  if (s.lastBalancingMs != null /* MUTANT */\n    && nowMs - s.graceFromMs < VDIFF_KNEE_MAX_MUTE_MS)',
    why: 'A slow-relaxing real imbalance (2026-08-22/23, Core 3) is silent until the duration bound.',
  },
  {
    id: 'vii. ★★ the end-of-charge grace applies off the top of charge',
    file: AL,
    find: '  if (!topOfCharge) return null;\n',
    to: '  /* MUTANT */\n',
    why: 'A plateau spread below 95% SoC is muted on evidence earned at the top.',
  },
  {
    id: 'viii. ★★★ activity below the warn line counts as knee evidence',
    file: AL,
    find: '  } else if (kneeSpread) {',
    to: '  } else if (true) { /* MUTANT */',
    why: 'Ordinary top-of-charge balancing at a 10 mV spread opens a grace for a spread that then jumps to the line.',
  },
  {
    id: 'ix. ★★★ leaving the top of charge keeps the evidence (and activity at any SoC counts)',
    file: AL,
    find: '  if (!topOfCharge) {\n    s.lastBalancingMs = null;',
    to: '  if (false) { /* MUTANT */\n    s.lastBalancingMs = null;',
    why: 'Mid-SoC activity opens the end-of-charge grace at the top: evidence outlives the knee it described.',
  },
  /* ── review-1: charge input is narrower evidence than balancing ───────── */
  {
    id: 'x. ★★★ a charge tick refreshes the BALANCING window (the pre-review lastActiveMs)',
    file: AL,
    find: '    if (obs.balancing) s.lastBalancingMs = nowMs;',
    to: '    if (obs.balancing || (obs.chargeW ?? 0) > VDIFF_KNEE_CHARGE_W) s.lastBalancingMs = nowMs; /* MUTANT */',
    why: 'A real fault on a steady trickle at 99% (BMS idle) is "relaxing" for the whole charge, up to 20 minutes; v1.186.5 spoke at once.',
  },
  {
    id: 'xi. ★★★ the charge-only grace is not bounded from the FIRST crossing',
    file: AL,
    find: "    && nowMs - s.graceFromMs < VDIFF_KNEE_RELAX_MS) return 'charging';",
    to: "    ) return 'charging'; /* MUTANT */",
    why: 'Each charge tick extends its own mute: the steady-trickle fault is silent until the 20-minute bound.',
  },
  {
    id: 'xii. ★★★ charge evidence need not be recent',
    file: AL,
    find: '  if (s.lastChargeMs != null && nowMs - s.lastChargeMs < VDIFF_KNEE_RELAX_MS',
    to: '  if (s.lastChargeMs != null /* MUTANT */',
    why: 'A charge seen an hour ago at the top graces a brand-new crossing on an idle pack.',
  },
  {
    id: 'xiii. ★ the charge line is inclusive',
    file: AL,
    find: '    if ((obs.chargeW ?? 0) > VDIFF_KNEE_CHARGE_W) s.lastChargeMs = nowMs;',
    to: '    if ((obs.chargeW ?? 0) >= VDIFF_KNEE_CHARGE_W) s.lastChargeMs = nowMs; /* MUTANT */',
    why: 'A 50 W reading (the documented line, exclusive) counts as charging.',
  },
  /* ── review-2: the stream's own input only ─────────────────────────────── */
  {
    id: 'xiv. ★★★ no stream value → the polled (or liveFlow-copied) input counts',
    file: AL,
    find: '  if (s == null || !Number.isFinite(s.w) || !Number.isFinite(s.atMs)) return null;',
    to: '  if (s == null || !Number.isFinite(s.w) || !Number.isFinite(s.atMs)) return pk.liveFlow?.inputWatts ?? pk.inputWatts ?? null; /* MUTANT */',
    why: 'With the stream silent the REST poll replays the last non-zero 200 W, and the grace outlives the stop.',
  },
  {
    id: 'xv. ★★★ a STALE stream value counts',
    file: AL,
    find: '  return nowMs - s.atMs <= VDIFF_KNEE_STREAM_FRESH_MS ? s.w : null;',
    to: '  return s.w; /* MUTANT */',
    why: 'A stream that went silent mid-charge keeps its last 200 W forever: "charging" never ends.',
  },
  {
    id: 'xvi. ★★★ the snapshot writes the polled input into streamInputW',
    file: SN,
    find: '      if (si) pk.streamInputW = { w: si.v, atMs: si.atMs };',
    to: '      pk.streamInputW = si ? { w: si.v, atMs: si.atMs } : { w: pk.inputWatts ?? 0, atMs: now }; /* MUTANT */',
    why: 'The alarm copy of the charge input becomes the REST replay it exists to exclude.',
  },
  {
    id: 'xvii. ★★ the snapshot takes the REST value over the stream\'s own',
    file: SN,
    find: '      if (si) pk.streamInputW = { w: si.v, atMs: si.atMs };',
    to: '      if (si) pk.streamInputW = { w: pk.inputWatts ?? si.v, atMs: now }; /* MUTANT */',
    why: 'After a REST poll the stream\'s 0 W is overwritten by the replayed 564 W, freshly stamped.',
  },
  /* ── review-4: the episode clock ──────────────────────────────────────── */
  {
    id: 'xviii. ★★ a dip below the critical line restarts the duration clock',
    file: AL,
    find: '    if (nowMs - s.belowCritSinceMs >= VDIFF_KNEE_RELAX_MS) {',
    to: '    if (true) { /* MUTANT */',
    why: 'A spread hovering on the line evades the duration bound indefinitely.',
  },
  {
    id: 'xix. ★★ a relaxed spread never ends its episode',
    file: AL,
    find: '    if (nowMs - s.belowCritSinceMs >= VDIFF_KNEE_RELAX_MS) {',
    to: '    if (false) { /* MUTANT */',
    why: 'A second top-of-charge crossing 25 minutes later is a false red, voiced as "20 minutes at the line".',
  },
  {
    id: 'xx. ★★ a return above the line does not reset the under-the-line run',
    file: AL,
    find: '    s.critSinceMs ??= nowMs;\n    s.belowCritSinceMs = null;',
    to: '    s.critSinceMs ??= nowMs; /* MUTANT */',
    why: 'Short dips add up to a "relaxed" run: a hovering spread restarts its clock every 5 minutes of dips.',
  },
  {
    id: 'xxi. ★★★ the knee is advanced only on critical readings',
    file: AL,
    find: '        const knee = advanceVdiffKnee(kneePrev, kneeObs, now);',
    to: '        const knee = pk.maxVolDiffMv >= critMv ? advanceVdiffKnee(kneePrev, kneeObs, now) : { packSn: null, lastBalancingMs: null, lastChargeMs: null, critSinceMs: null, belowCritSinceMs: null, graceFromMs: null, lastSeenMs: null }; /* MUTANT */',
    why: 'Evidence earned in the warn band is lost; a critical reading that lands after charging stopped (180 s cadence) sounds.',
  },
  {
    id: 'xxii. ★★ a swapped pack inherits the grace',
    file: AL,
    find: '  const sameHw = prev != null && !(prev.packSn != null && obs.packSn != null && prev.packSn !== obs.packSn);',
    to: '  const sameHw = prev != null; /* MUTANT */',
    why: 'A different battery in the slot is muted on the previous battery\'s end-of-charge evidence.',
  },
  /* ── review-5: across a reading gap ───────────────────────────────────── */
  {
    id: 'xxiii. ★★★ the activity evidence is carried across a reading gap',
    file: AL,
    find: '    else vdiffKneeByKey.set(k, { ...st, lastBalancingMs: null, lastChargeMs: null, belowCritSinceMs: null });',
    to: '    else vdiffKneeByKey.set(k, { ...st }); /* MUTANT */',
    why: 'A mute is carried across blindness instead of being re-earned from fresh readings.',
  },
  {
    id: 'xxiv. ★★★ a reading gap drops the critical-line clock',
    file: AL,
    find: '    if ((st.critSinceMs == null && st.graceFromMs == null) || st.lastSeenMs == null || now - st.lastSeenMs > VDIFF_KNEE_GAP_CARRY_MS) vdiffKneeByKey.delete(k);',
    to: '    if (true) vdiffKneeByKey.delete(k); /* MUTANT */',
    why: 'An offline blip every few minutes restarts the 20-minute bound: a balancing-muted fault never speaks.',
  },
  {
    id: 'xxv. ★ no cap on how long a gap carries the clock',
    file: AL,
    find: '    if ((st.critSinceMs == null && st.graceFromMs == null) || st.lastSeenMs == null || now - st.lastSeenMs > VDIFF_KNEE_GAP_CARRY_MS) vdiffKneeByKey.delete(k);',
    to: '    if ((st.critSinceMs == null && st.graceFromMs == null) || st.lastSeenMs == null) vdiffKneeByKey.delete(k); /* MUTANT */',
    why: 'A pack back after a day offline is greeted by its old episode: an immediate red on its first balancing tick.',
  },
  /* ── cell overvoltage ─────────────────────────────────────────────────── */
  {
    id: 'xxvi. ★★★ the overvoltage line is exclusive',
    file: AL,
    find: '      if (maxCellMv != null && Number.isFinite(maxCellMv) && maxCellMv >= CELL_OVP_CRIT_MV && maxCellMv < CELL_OVP_IMPLAUSIBLE_MV) {',
    to: '      if (maxCellMv != null && Number.isFinite(maxCellMv) && maxCellMv > CELL_OVP_CRIT_MV && maxCellMv < CELL_OVP_IMPLAUSIBLE_MV) { /* MUTANT */',
    why: 'A cell at exactly 3.600 V is not reported.',
  },
  {
    id: 'xxvii. ★★ the "unknown" sentinel raises a critical',
    file: AL,
    find: '      if (maxCellMv != null && Number.isFinite(maxCellMv) && maxCellMv >= CELL_OVP_CRIT_MV && maxCellMv < CELL_OVP_IMPLAUSIBLE_MV) {',
    to: '      if (maxCellMv != null && Number.isFinite(maxCellMv) && maxCellMv >= CELL_OVP_CRIT_MV) { /* MUTANT */',
    why: 'A 65535 "unknown" reading sounds a false overvoltage klaxon.',
  },
  {
    id: 'xxviii. ★★★ the overvoltage critical can be muted (bench stamp / off-panel demotion)',
    file: AL,
    find: "  if (a.id.startsWith('cell-ovp-')) return true;",
    to: '  /* MUTANT */',
    why: 'A bench chassis on a charger with a cell at the overvoltage line pages nobody.',
  },
  {
    id: 'xxix. ★★ the overvoltage family is not device-derived',
    file: AM,
    find: "  'cell-ovp-', // v1.187.0 — the pack's highest cell voltage, from the same per-pack block",
    to: '  /* MUTANT */',
    why: 'Before the first complete poll a standing overvoltage alert resolves as if it cleared.',
  },
  /* ── the peer outlier's audible ───────────────────────────────────────── */
  {
    id: 'xxx. ★★★ the peer top-of-charge gate is gone',
    file: AN,
    find: '          ...(topOfChargeSpread ? { audible: false } : {}),',
    to: '          /* MUTANT */',
    why: 'Every full-charge afternoon speaks yellows for the pack that reached the knee first (2026-09-29).',
  },
  {
    id: 'xxxi. ★★★ the peer gate drops the push too (annunciate:false)',
    file: AN,
    find: '          ...(topOfChargeSpread ? { audible: false } : {}),',
    to: '          ...(topOfChargeSpread ? { annunciate: false } : {}), /* MUTANT */',
    why: 'A sub-critical top-of-charge spread is neither spoken nor pushed — the backstop v1.45.0 relies on is gone.',
  },
  {
    id: 'xxxii. ★★★ the peer gate reads the Core SoC instead of the outlier pack',
    file: AN,
    find: "        const topOfChargeSpread = metric.key === 'voldiff' && topOfChargeQuietSpread(pk.soc ?? d.projection.soc, v);",
    to: "        const topOfChargeSpread = metric.key === 'voldiff' && topOfChargeQuietSpread(d.projection.soc, v); /* MUTANT */",
    why: 'A diverging pack at 80% is quieted because its siblings are full.',
  },
  {
    id: 'xxxiii. ★★ the peer gate is not scoped to the cell-spread metric',
    file: AN,
    find: "        const topOfChargeSpread = metric.key === 'voldiff' && topOfChargeQuietSpread(pk.soc ?? d.projection.soc, v);",
    to: '        const topOfChargeSpread = topOfChargeQuietSpread(pk.soc ?? d.projection.soc, v); /* MUTANT */',
    why: 'A worn (SoH) outlier at top of charge stops being spoken.',
  },
  /* ── review-3: the outlier yields to its pack's held critical ─────────── */
  {
    id: 'xxxiv. ★★★ the monitor does not stamp the outlier under a held critical',
    file: AM,
    find: '    const liveHead: Alert[] = quietPeerSpreadUnderHeldCritical([',
    to: '    const liveHead: Alert[] = ([ /* MUTANT */',
    why: 'During the knee the outlier voices yellow / all-clear / yellow / all-clear in place of the suppressed red (2026-09-29 15:32-15:38).',
  },
  {
    id: 'xxxv. ★★★ the stamp does nothing',
    file: AM,
    find: '    a.audible = false;\n',
    to: '    /* MUTANT */\n',
    why: 'As xxxiv: the Core 1 replay speaks a yellow at 15:32:00.',
  },
  {
    id: 'xxxvi. ★★★ the stamp drops the push instead of the audible',
    file: AM,
    find: '    a.audible = false;\n',
    to: '    a.annunciate = false; /* MUTANT */\n',
    why: 'A 93-101 mV outlier is neither spoken nor pushed while its critical is held.',
  },
  {
    id: 'xxxvii. ★★ a critical that still annunciates counts as held',
    file: AM,
    find: "    if (a.id.startsWith('vdiff-crit-') && a.mutedBy != null && a.annunciate === false) {",
    to: "    if (a.id.startsWith('vdiff-crit-') && a.mutedBy != null) { /* MUTANT */",
    why: 'An inconsistent critical (mutedBy set, still speaking) silences its outlier with nothing held.',
  },
  {
    id: 'xxxviii. ★★ the stamp quiets every peer metric of the pack',
    file: AM,
    find: "    if (!a.id.startsWith('peer-voldiff-') || a.audible === false) continue;\n    const why = held.get(a.id.slice('peer-voldiff-'.length));",
    to: "    if (!a.id.startsWith('peer-') || a.audible === false) continue; /* MUTANT */\n    const why = held.get(a.id.replace(/^peer-[a-z]+-/, ''));",
    why: 'A hot or worn pack at top of charge stops being spoken because its cell spread is on the knee.',
  },
  {
    id: 'xxxix. ★ the stamp matches packs by prefix',
    file: AM,
    find: "    const why = held.get(a.id.slice('peer-voldiff-'.length));",
    to: "    const why = [...held].find(([k]) => a.id.slice('peer-voldiff-'.length).startsWith(k))?.[1]; /* MUTANT */",
    why: 'Pack 1 held quiets pack 11.',
  },
  /* ── the audible chain (review-6) ─────────────────────────────────────── */
  {
    id: 'xl. ★★★ the audible condition counts audible:false',
    file: BC,
    find: '      a.audible !== false &&',
    to: '      /* MUTANT */',
    why: 'The top-of-charge peer outlier raises yellow and the all-clear again.',
  },
  {
    id: 'xli. ★★★ the broadcast tick keeps audible:false in the spoken array',
    file: BC,
    find: '    .filter((a) => a.audible !== false)\n',
    to: '    /* MUTANT */\n',
    why: 'When another warning raises yellow, the quiet peer outlier can be the alert that is voiced.',
  },
  {
    id: 'xlii. ★★ the tick bypasses speakableAlerts',
    file: BC,
    find: '    const alerts = speakableAlerts((store.get().alerts ?? []) as Alert[], tickNow, getAlertOnset);',
    to: '    const alerts = ((store.get().alerts ?? []) as Alert[]); /* MUTANT */',
    why: 'Silenced priorities, audible:false and the imbalance speak hold all stop applying to the broadcast.',
  },
  {
    id: 'xliii. ★★ the voiced-primary choice accepts audible:false',
    file: TT,
    find: '  const candidates = alerts.filter((a) => a.severity === targetSeverity && a.annunciate !== false && a.audible !== false);',
    to: '  const candidates = alerts.filter((a) => a.severity === targetSeverity && a.annunciate !== false); /* MUTANT */',
    why: 'Any caller that builds a message without the tick filter can voice the quiet outlier.',
  },
  {
    id: 'xliv. ★★★ the rising-edge push gate reads audible',
    file: AM,
    find: '  return a.annunciate !== false;\n}',
    to: '  return a.annunciate !== false && (a as { audible?: boolean }).audible !== false; /* MUTANT */\n}',
    why: 'The quiet outlier stops reaching the phone — the v1.45.0 backstop is gone.',
  },
  {
    id: 'xlv. ★ the silent-critical log line blames the bench again',
    file: AM,
    find: "  const reason = a.muteReason ?? (a.mutedBy != null ? CELL_SPREAD_MUTE_TEXT[a.mutedBy] : 'by policy — reason not recorded');",
    to: "  const reason = a.muteReason ?? 'bench spare or off-panel Core'; /* MUTANT */",
    why: 'The log review chases membership for a balancing mute on a home Core (2026-09-29).',
  },
  /* ── log review 09-29: the graces are bounded by the top-of-charge SESSION ─── */
  {
    id: 'xlvi. ★★★ the end-of-charge grace is bounded by the current crossing only',
    file: AL,
    find: "    && nowMs - s.graceFromMs < VDIFF_KNEE_MAX_MUTE_MS) return 'end-of-charge';",
    to: "    ) return 'end-of-charge'; /* MUTANT */",
    why: 'A 100 mV reading between balancing 45 mV readings is muted all afternoon: each dip restarts the duration bound.',
  },
  {
    id: 'xlvii. ★★★ the charging grace is bounded by the current crossing (critSinceMs) again',
    file: AL,
    find: "    && nowMs - s.graceFromMs < VDIFF_KNEE_RELAX_MS) return 'charging';",
    to: "    && s.critSinceMs != null && nowMs - s.critSinceMs < VDIFF_KNEE_RELAX_MS) return 'charging'; /* MUTANT */",
    why: 'A spread that follows the charge current (95 / 45 mV readings) earns a fresh grace on every crossing: 0 of 271 critical ticks announced in 3 h.',
  },
  {
    id: 'xlviii. ★★★ the session ends with the critical-line episode',
    file: AL,
    find: '    s.critSinceMs = null;\n    s.belowCritSinceMs = null;\n  } else if (obs.spreadMv >= vdiffCritMvFor(obs.packSoc)) {',
    to: '    s.critSinceMs = null;\n    s.belowCritSinceMs = null;\n    s.graceFromMs = null; /* MUTANT */\n  } else if (obs.spreadMv >= vdiffCritMvFor(obs.packSoc)) {',
    why: 'As xlvii: a dip under 50 mV re-grants both graces.',
  },
  {
    id: 'xlix. ★★ an unknown SoC ends the session',
    file: AL,
    find: '  if (obs.packSoc != null && obs.packSoc < VOL_DIFF_PLATEAU_QUIET_SOC_PCT) {\n    s.graceFromMs = null;',
    to: '  if (obs.packSoc == null || obs.packSoc < VOL_DIFF_PLATEAU_QUIET_SOC_PCT) { /* MUTANT */\n    s.graceFromMs = null;',
    why: 'A reading with no SoC re-grants the graces: missing data opens a mute.',
  },
  {
    id: 'l. ★★ leaving the top of charge does not end the session',
    file: AL,
    find: '  if (obs.packSoc != null && obs.packSoc < VOL_DIFF_PLATEAU_QUIET_SOC_PCT) {\n    s.graceFromMs = null;',
    to: '  if (false) { /* MUTANT */\n    s.graceFromMs = null;',
    why: 'The next day\'s benign knee (or one after a discharge) is a false red on a session that ended hours ago.',
  },
  {
    id: 'li. ★★ the session starts when the pack reaches the top, not at the episode\'s first crossing',
    file: AL,
    find: '    s.graceFromMs ??= s.critSinceMs ?? nowMs;',
    to: '    s.graceFromMs ??= nowMs; /* MUTANT */',
    why: 'A crossing at 93% that reaches 95% three minutes later is muted for 8 minutes of charging, not 5.',
  },
  {
    id: 'lii. ★★★ the session never starts',
    file: AL,
    find: '    s.graceFromMs ??= s.critSinceMs ?? nowMs;',
    to: '    /* MUTANT */',
    why: 'No grace at all: the 09-29 end-of-charge knees sound the critical klaxon again.',
  },
  {
    id: 'liii. ★★★ the session clock is not carried across a reading gap',
    file: AL,
    find: '    if ((st.critSinceMs == null && st.graceFromMs == null) || st.lastSeenMs == null || now - st.lastSeenMs > VDIFF_KNEE_GAP_CARRY_MS) vdiffKneeByKey.delete(k);',
    to: '    if (st.critSinceMs == null || st.lastSeenMs == null || now - st.lastSeenMs > VDIFF_KNEE_GAP_CARRY_MS) vdiffKneeByKey.delete(k); /* MUTANT */',
    why: 'A missed reading during a sub-line reading hands the next crossing a fresh grace.',
  },
  /* ── log review 09-29: across a restart ──────────────────────────────── */
  {
    id: 'liv. ★★★ a pack with no state starts from a clean clock (no restart seed)',
    file: AL,
    find: '        const kneePrev = vdiffKneeByKey.get(vdiffKey) ?? vdiffKneeSeed(getAlertOnset(`vdiff-crit-${vdiffKey}`), pk.packSn ?? null, now);',
    to: '        const kneePrev = vdiffKneeByKey.get(vdiffKey); /* MUTANT */',
    why: 'An auto-update at minute 21 of a balancing-held spread buys 20 more minutes of silence.',
  },
  {
    id: 'lv. ★★ the seed restores the episode clock but not the session',
    file: AL,
    find: '  return { packSn, lastBalancingMs: null, lastChargeMs: null, critSinceMs: at, belowCritSinceMs: null, graceFromMs: at, lastSeenMs: null };',
    to: '  return { packSn, lastBalancingMs: null, lastChargeMs: null, critSinceMs: at, belowCritSinceMs: null, graceFromMs: null, lastSeenMs: null }; /* MUTANT */',
    why: 'A restart during a sub-line reading of the charge-following fault re-grants its grace.',
  },
  {
    id: 'lvi. ★ an onset ahead of the clock is trusted',
    file: AL,
    find: '  const at = Math.min(onsetMs, nowMs);',
    to: '  const at = onsetMs; /* MUTANT */',
    why: 'After a clock step backward the bounds count from the future: every grace outlives its window.',
  },
  {
    id: 'lvii. ★★★ a critical is boot-seeded without a delivery record',
    file: AM,
    find: "  if (p.alert.severity === 'critical') return p.alreadyNotified;",
    to: '  /* MUTANT */',
    why: 'A vdiff-crit held by a grace across an auto-update is spoken when the grace lapses but never pushed.',
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
console.log(`mutate-v1187-a: ${MUTANTS.length} mutants against ${SUBSET.join(' + ')}\n`);

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
