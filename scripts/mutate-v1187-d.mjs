#!/usr/bin/env node
/**
 * mutate-v1187-d.mjs — committed harness for v1.187.0 (night charge + money): the ledger's
 * on-peak outcome measures the on-peak the plan GOVERNS, realized cost is written from
 * metered import × the tariff, a PV verdict graded against another fleet is set aside
 * (narrowly, and counted), the reserve write holds exactly the cheap window, /api/tariff
 * reports the table that prices, and the on-peak idle-pool notice (advisory, never audible).
 *
 * Review pass (v1.187.0): the scorer's assembly (on-peak query, supersede skip, cost span and
 * coverage gate, delivered-energy span, PV set-aside) and the idle-pool input assembly moved
 * into pure functions, so the mutants that were killed only by source pins (xii, xv-xviii,
 * xxix) now target those functions and die in behavioural tests; xxx+ cover the review's new
 * guards (the close OFF ordering, the restore stamp and the hold span, the cost reasons).
 *
 *   node scripts/mutate-v1187-d.mjs
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
const NLS = resolve(SERVER, 'src/nightLedgerScoring.ts');
const GATE = resolve(SERVER, 'src/nightChargeGate.ts');
const ACT = resolve(SERVER, 'src/nightChargeActuator.ts');
const PGD = resolve(SERVER, 'src/peakGridDraw.ts');
const BC = resolve(SERVER, 'src/broadcast.ts');
const AN = resolve(SERVER, 'src/analytics.ts');
const TAR = resolve(SERVER, 'src/tariff.ts');
const IX = resolve(SERVER, 'src/index.ts');
const AM = resolve(SERVER, 'src/alertMonitor.ts');
const NFC = resolve(SERVER, 'src/nightForceCharge.ts');
const REC = resolve(SERVER, 'src/recorder.ts');

const SUBSET = [
  'test/ledgerOnPeakGoverned.test.ts',
  'test/ledgerRealizedCost.test.ts',
  'test/tariffReportHonest.test.ts',
  'test/nightChargeWriteHoldsTheWindow.test.ts',
  'test/readinessPvSetAside.test.ts',
  'test/peakIdlePool.test.ts',
  'test/ledgerScorerAssembly.test.ts',
  'test/nightChargeCloseOffFirst.test.ts',
  'test/ledgerRevertStamp.test.ts',
  'test/ownerFloorAttribution.test.ts',
];

const MUTANTS = [
  // ── the governed on-peak span ──
  {
    id: 'i. ★★★ the on-peak span starts on the plan day again (before the window)',
    file: NLS,
    find: '  const from = Math.ceil(windowEndMs / HOUR_MS) * HOUR_MS;',
    to: '  const from = Math.ceil(windowEndMs / HOUR_MS) * HOUR_MS - 13 * HOUR_MS; /* MUTANT */',
    why: 'The 09-28 plan is charged with Monday afternoon\'s 4.27 kWh, bought before it existed.',
  },
  {
    id: 'ii. ★★ the search runs past the next cheap window',
    file: NLS,
    find: '    if (isCheapAt(t)) return null;',
    to: '    /* MUTANT */',
    why: 'A Friday plan claims Monday\'s on-peak, which the Sunday plan governs.',
  },
  {
    id: 'iii. ★★ a superseded row keeps the on-peak',
    file: NLS,
    // (review) — multi-line: realizedCostOutcome opens with the same test.
    find: "  if (i.supersededBy != null) {\n    return {\n      basis: 'superseded',",
    to: "  if (false /* MUTANT */) {\n    return {\n      basis: 'superseded',",
    why: 'Saturday and Sunday both record Monday\'s on-peak import; a sum counts it twice.',
  },
  {
    id: 'iv. ★★ any later plan supersedes, whatever its window',
    file: NLS,
    find: '    if (o.window_start_ms !== row.window_start_ms || o.window_end_ms !== row.window_end_ms) continue;',
    to: '    /* MUTANT */',
    why: 'Every row but the newest loses its on-peak and its cost.',
  },
  {
    id: 'v. ★★ an under-covered on-peak span writes a deflated total',
    file: NLS,
    find: '  if (i.importKwh == null || i.coverage == null || !(i.coverage >= LEDGER_SPAN_MIN_COVERAGE)) {',
    to: '  if (i.importKwh == null) { /* MUTANT */',
    why: 'A half-recorded on-peak reads as a low import in a never-pruned ledger.',
  },
  {
    id: 'vi. ★★ an unknown rate is priced as free',
    file: NLS,
    find: '    if (rate == null || !Number.isFinite(rate)) return { cents: null, unpriced: slice };',
    to: '    if (rate == null || !Number.isFinite(rate)) continue; /* MUTANT */',
    why: 'Unconfirmed rates record a realized cost of $0 instead of null.',
  },
  // ── the PV verdict set-aside ──
  {
    id: 'vii. ★★★ every incomplete-basis night is dropped from the PV statistics (survivorship)',
    file: GATE,
    find: '  const pvEvidence = (r: NightLedgerRow): boolean => r.pv_verdict_set_aside == null;',
    to: '  const pvEvidence = (r: NightLedgerRow): boolean => r.pv_verdict_set_aside == null && r.min_proj_soc_pct !== null; /* MUTANT */',
    why: 'The lasting-failure nights (09-11: 72% < 78%) vanish and PV coverage reads better than it is.',
  },
  {
    id: 'viii. ★★ the gate ignores the set-aside',
    file: GATE,
    find: '  const pvEvidence = (r: NightLedgerRow): boolean => r.pv_verdict_set_aside == null;',
    to: '  const pvEvidence = (_r: NightLedgerRow): boolean => true; /* MUTANT */',
    why: 'The 09-27 one-Core band still counts as a covered night.',
  },
  {
    id: 'ix. ★★ the sample size counts set-aside verdicts',
    file: GATE,
    find: '  const coverageNights = pvPool.filter((r) => r.pv_in_band != null && r.load_in_band != null).length;',
    to: '  const coverageNights = forecastPool.filter((r) => r.pv_in_band != null && r.load_in_band != null).length; /* MUTANT */',
    why: 'MIN_COVERAGE_NIGHTS is met with nights whose PV verdict is not evidence.',
  },
  {
    id: 'x. ★★ a fleet mismatch is never detected',
    file: NLS,
    find: '  if (modelSns === actual) return null;',
    to: '  return null; /* MUTANT */',
    why: 'A band fitted on one Core is graded against three, forever.',
  },
  {
    id: 'xi. ★ the known row matches by date alone',
    file: NLS,
    find: '    (k) => k.planDate === String(row.plan_date) && k.issuedAtMs === row.issued_at_ms,',
    to: '    (k) => k.planDate === String(row.plan_date) /* MUTANT */,',
    why: 'Another install\'s 2026-09-27 row would be tagged.',
  },
  {
    id: 'xii. ★★ the scorer never records the set-aside',
    file: NLS,
    find: '  const pvSetAside = pvVerdictSetAside(i.row.pv_model_sns, i.homeSns) ?? knownFleetMismatchReason(i.row);',
    to: '  const pvSetAside = null; /* MUTANT */',
    why: 'The check exists and nothing writes it — the AUTO-write readiness gate keeps counting the band.',
  },
  // ── the reserve write holds the window ──
  {
    id: 'xiii. ★★★ the write fires 5 min before the window again',
    file: ACT,
    find: 'export const APPLY_LEAD_MS = 0;',
    to: 'export const APPLY_LEAD_MS = 5 * 60_000; /* MUTANT */',
    why: '~1 kWh a night bought at 16.91¢ instead of 12.59¢.',
  },
  {
    id: 'xiv. ★★ the restore lands 5 min after the window again',
    file: ACT,
    find: 'export const REVERT_LAG_MS = 0;',
    to: 'export const REVERT_LAG_MS = 5 * 60_000; /* MUTANT */',
    why: 'A still-short pack keeps grid-charging into the off-peak morning.',
  },
  {
    id: 'xv. ★ the delivered span forgets the legacy schedule',
    file: NLS,
    find: '  if (applied < i.windowStartMs) {',
    to: '  if (false /* MUTANT */) {',
    why: 'A night actuated wholly on the old schedule drops five minutes of delivered energy.',
  },
  // ── the ledger wiring (the scorer's assembly) ──
  {
    id: 'xvi. ★★ completion no longer waits for the governed on-peak',
    file: NLS,
    find: '  return { onpeak, scoreSpanEndMs, completeMs: Math.max(scoreSpanEndMs, onpeak?.endMs ?? 0) };',
    to: '  return { onpeak, scoreSpanEndMs, completeMs: scoreSpanEndMs }; /* MUTANT */',
    why: 'On a calendar whose on-peak closes after close + 16 h the column is captured mid-span.',
  },
  {
    id: 'xvii. ★★ a superseded row measures the on-peak anyway',
    file: NLS,
    find: '  const onpeakSpan = ofRecord ? i.onpeak : null;',
    to: '  const onpeakSpan = i.onpeak; /* MUTANT */',
    why: 'The shared Monday on-peak is queried for both weekend rows.',
  },
  {
    id: 'xviii. ★★ realized cost is written over an under-covered span',
    file: NLS,
    find: '  if (!(cov >= LEDGER_SPAN_MIN_COVERAGE)) {',
    to: '  if (false /* MUTANT */) {',
    why: 'A night with a telemetry hole records a cost that is simply too low.',
  },
  // ── /api/tariff ──
  {
    id: 'xix. ★★ the report prints the legacy window on a confirmed table',
    file: AN,
    find: '    onPeakHours: win?.hours ?? legacy.hours,',
    to: '    onPeakHours: legacy.hours /* MUTANT */,',
    why: '"15-20" again: two hours of on-peak that nothing charges.',
  },
  {
    id: 'xx. ★ the overnight rate is left out',
    file: AN,
    find: "    overnightCents: inSeason('overnight')?.centsBySeason[season] ?? null,",
    to: '    overnightCents: null /* MUTANT */,',
    why: 'The rate that prices every overnight kWh appears nowhere.',
  },
  {
    id: 'xxi. ★ the day scale is not mapped (0=Sun vs 1=Mon)',
    file: TAR,
    find: '  const monFirst = [...new Set(p.weekdays.map((d) => (d === 0 ? 7 : d)))].sort((a, b) => a - b);',
    to: '  const monFirst = [...new Set(p.weekdays)].sort((a, b) => a - b); /* MUTANT */',
    why: 'A weekend window reads "0,6".',
  },
  // ── the idle-pool notice ──
  {
    id: 'xxii. ★★★ the near-reserve guard is gone',
    file: PGD,
    find: "  if (i.socPct <= i.reserveSocPct + cfg.headroomPct) return { ...base, suppressed: 'near-reserve' };",
    to: '  /* MUTANT */',
    why: 'It advises spending outage margin while the panel is defending the floor.',
  },
  {
    id: 'xxiii. ★★ a discharging pool counts as idle',
    file: PGD,
    find: "  if (poolFlowW > cfg.maxPoolFlowW) return { ...base, suppressed: 'pool-active' };",
    to: '  /* MUTANT */',
    why: 'Every on-peak afternoon with any grid draw pushes.',
  },
  {
    id: 'xxiv. ★★ the on-peak gate is gone',
    file: PGD,
    find: "  if (!slice.isOnPeak) return { ...base, suppressed: 'off-peak' };",
    to: '  /* MUTANT */',
    why: 'Weekends and nights push a money notice for off-peak energy.',
  },
  {
    id: 'xxv. ★★ a frozen projection is trusted',
    file: PGD,
    find: '  if (!i.fresh || i.gridImportW == null || i.socPct == null || i.reserveSocPct == null || flows.length === 0) {',
    to: '  if (i.gridImportW == null || i.socPct == null || i.reserveSocPct == null || flows.length === 0) { /* MUTANT */',
    why: 'A cloud-dark panel\'s last reading reports a pool idle for hours.',
  },
  {
    id: 'xxvi. ★★ more than once per on-peak day',
    file: PGD,
    find: '  if (st.firedDay === ctx.day) return { state: { ...st, onsetMs: onset }, active: false };',
    to: '  /* MUTANT */',
    why: 'An afternoon that flips between discharging and idle pushes each time.',
  },
  {
    id: 'xxvii. ★★ a load dip resolves it at once',
    file: PGD,
    find: '    if (ctx.nowMs - clearSince >= cfg.clearMs) {',
    to: '    if (true /* MUTANT */) {',
    why: 'Fire, resolve, and a suppressed re-rise: a false "Resolved:" mid-episode.',
  },
  {
    id: 'xxviii. ★★★ the notice raises the chime',
    file: BC,
    find: "      !a.id.startsWith('peak-idle-pool'),",
    to: '      true /* MUTANT */,',
    why: 'Money spoken in the yellow tier a grid loss uses.',
  },
  {
    id: 'xxix. ★★ the monitor ignores staleness',
    file: AM,
    find: '    fresh: shp2 != null && deviceEvidencePositive(devices[shp2.sn], nowMs),',
    to: '    fresh: shp2 != null /* MUTANT */,',
    why: 'The freshness gate in the detector is inert on every real tick.',
  },
  // ── review: the force-charge OFF at the close goes out first ──
  {
    id: 'xxx. ★★★ the force-charge OFF waits behind the revert again',
    file: NFC,
    find: "  return forceChargeOffDueNow(s, nowMs) ? ['forceCharge', 'reserve'] : ['reserve', 'forceCharge'];",
    to: "  return ['reserve', 'forceCharge']; /* MUTANT */",
    why: 'A slow revert PUT (300 s) holds the OFF while the Cores grid-charge at 16-19 kW.',
  },
  {
    id: 'xxxi. ★★★ the OFF-first order is taken on every tick',
    file: NFC,
    find: "  return forceChargeOffDueNow(s, nowMs) ? ['forceCharge', 'reserve'] : ['reserve', 'forceCharge'];",
    to: "  return ['forceCharge', 'reserve']; /* MUTANT */",
    why: 'The START no longer reads the reserve the step just verified (apply → readback → ceiling → ON).',
  },
  {
    id: 'xxxii. ★★ a cancelled night does not put the OFF first',
    file: NFC,
    find: '  return s.cancelled || s.revertedAtMs != null || s.windowEndMs == null || nowMs >= s.windowEndMs;',
    to: '  return s.revertedAtMs != null || s.windowEndMs == null || nowMs >= s.windowEndMs; /* MUTANT */',
    why: 'The owner\'s cancel holds the OFF behind the immediate revert.',
  },
  {
    id: 'xxxiii. ★★ an OFF already issued still reorders the tick',
    file: NFC,
    find: '  if (s.forceChargeOnAtMs == null || s.forceChargeOffAtMs != null) return false;',
    to: '  if (s.forceChargeOnAtMs == null) return false; /* MUTANT */',
    why: 'The OFF verification and ceiling restore run ahead of the reserve step for the rest of the night.',
  },
  {
    id: 'xxxiv. ★★★ one step\'s failure skips the other',
    file: NFC,
    find: '      onError(step, e);',
    to: '      throw e; /* MUTANT */',
    why: 'A throwing revert skips the force-charge OFF (or the reverse) — the v1.165.0 rule.',
  },
  {
    id: 'xxxv. ★★ the morning summary is awaited again',
    file: IX,
    find: "    void sendNotification(loadNotifyConfig(), {\n      severity: 'info',\n      dedupId: 'night_charge_actuation',",
    to: "    await sendNotification(loadNotifyConfig(), { /* MUTANT */\n      severity: 'info',\n      dedupId: 'night_charge_actuation',",
    why: 'A slow notify target holds the tick behind an info push.',
  },
  // ── review: the delivered-energy span ends at the restore ──
  {
    id: 'xxxvi. ★★ the restore is never stamped on the ledger',
    file: IX,
    find: '    try { recorder.recordNightOutcome(state.day, { actuation_reverted_at_ms: nowMs }); }',
    to: '    try { /* MUTANT */ }',
    why: 'Every night falls back to the unstamped span; a late restore is never followed.',
  },
  {
    id: 'xxxvii. ★★ the stamp drops out of the ledger allowlist (SILENT)',
    file: REC,
    find: "  // v1.187.0 — when the reserve restore landed: the end of the delivered-energy span.\n  'actuation_reverted_at_ms',\n];",
    to: '  /* MUTANT */\n];',
    why: 'recordNightOutcome ignores unknown columns rather than throwing — the stamp vanishes with no error.',
  },
  {
    id: 'xxxviii. ★★ the stamp column is never migrated',
    file: REC,
    find: "    // v1.187.0 — see NightLedgerRow.actuation_reverted_at_ms.\n    'actuation_reverted_at_ms INTEGER',",
    to: '    /* MUTANT */',
    why: 'Every existing database lacks the column and the stamp write throws.',
  },
  {
    id: 'xxxix. ★★★ the delivered span ends at the close again (the tail)',
    file: NLS,
    find: "    return { startMs, endMs: restoreAt + HOLD_DEVICE_SETTLE_MS, basis: 'revert-stamp' };",
    to: "    return { startMs, endMs: i.windowEndMs, basis: 'revert-stamp' }; /* MUTANT */",
    why: '0.1-0.5 kWh a still-charging night bought after the close drops out of the de-bias calibrator\'s input.',
  },
  {
    id: 'xl. ★★ a restore hours late integrates the solar morning',
    file: NLS,
    find: '    const restoreAt = Math.min(Math.max(i.revertedAtMs, i.windowEndMs), i.windowEndMs + HOLD_TAIL_MAX_MS);',
    to: '    const restoreAt = Math.max(i.revertedAtMs, i.windowEndMs); /* MUTANT */',
    why: 'Import − load turns negative under PV and deflates delivered energy.',
  },
  {
    id: 'xli. ★ a cancel shrinks the span below the window',
    file: NLS,
    find: '    const restoreAt = Math.min(Math.max(i.revertedAtMs, i.windowEndMs), i.windowEndMs + HOLD_TAIL_MAX_MS);',
    to: '    const restoreAt = Math.min(i.revertedAtMs, i.windowEndMs + HOLD_TAIL_MAX_MS); /* MUTANT */',
    why: 'A cancelled or grid-loss night changes span semantics silently.',
  },
  {
    id: 'xlii. ★★ an unstamped night on the current schedule drops the restore tick',
    file: NLS,
    find: "  return { startMs, endMs: i.windowEndMs + ACTUATOR_TICK_MS + HOLD_DEVICE_SETTLE_MS, basis: 'close-plus-tick' };",
    to: "  return { startMs, endMs: i.windowEndMs, basis: 'close-plus-tick' }; /* MUTANT */",
    why: 'The tail defect again, on every night whose stamp write failed.',
  },
  {
    id: 'xliii. ★★ the stamp is ignored (the straddle night keeps the legacy tail)',
    file: NLS,
    find: "  if (typeof i.revertedAtMs === 'number' && Number.isFinite(i.revertedAtMs)) {",
    to: '  if (false /* MUTANT */) {',
    why: 'The restore\'s own time is recorded and never read.',
  },
  // ── review: the cost span, its supersede skip and its reasons ──
  {
    id: 'xliv. ★★ the cost span starts at the window close',
    file: NLS,
    find: '    startMs: Math.min(i.row.actuation_applied_at_ms ?? i.windowStartMs, i.windowStartMs),',
    to: '    startMs: i.windowEndMs, /* MUTANT */',
    why: 'The overnight buy — most of the night\'s cost — is left out of realized cost.',
  },
  {
    id: 'xlv. ★★ a superseded row queries the shared cost span',
    file: NLS,
    find: "    pts: ofRecord ? i.query('grid_home_w', costSpan.startMs, costSpan.endMs) : [],",
    to: "    pts: i.query('grid_home_w', costSpan.startMs, costSpan.endMs), /* MUTANT */",
    why: 'The shared Monday span is read for both weekend rows (one guard from a double count).',
  },
  {
    id: 'xlvi. ★★ a superseded row is priced',
    file: NLS,
    find: '  if (i.supersededBy != null) {\n    return { cents: null, note: `Cost: carried by',
    to: '  if (false /* MUTANT */) {\n    return { cents: null, note: `Cost: carried by',
    why: 'Saturday and Sunday both record Monday\'s cost; a sum counts it twice.',
  },
  {
    id: 'xlvii. ★★ an export is a credit',
    file: NLS,
    find: '    const kwh = ((Math.max(0, pts[i - 1].value) + Math.max(0, pts[i].value)) / 2) * dtH / 1000;',
    to: '    const kwh = ((pts[i - 1].value + pts[i].value) / 2) * dtH / 1000; /* MUTANT */',
    why: 'Midday export lowers a night\'s cost on a plan with no export credit.',
  },
  {
    id: 'xlviii. ★ unconfirmed rates read as a missing season rate',
    file: NLS,
    find: '  if (p.unpriced.ratesConfirmed === false) {',
    to: '  if (false /* MUTANT */) {',
    why: 'The note sends the owner to set one rate when the table is not confirmed at all.',
  },
  {
    id: 'xlix. ★ a plan with no window keeps a NULL on-peak basis',
    file: NLS,
    find: "    ? { onpeakBasis: 'none', notes:",
    to: '    ? { onpeakBasis: null /* MUTANT */, notes:',
    why: 'NULL again means both "legacy anchor" and "no window".',
  },
  {
    id: 'l. ★ the boot reports out-of-season periods',
    file: NLS,
    find: '    for (const season of p.seasons ?? all) {',
    to: '    for (const season of all) { /* MUTANT */',
    why: 'A summer "gap" for the winter-only super-off-peak is warned at every boot.',
  },
  {
    id: 'li. ★ the scorer drops the windowless basis',
    file: IX,
    find: '      onpeak_basis: wl.onpeakBasis,',
    to: '      /* MUTANT */',
    why: 'A windowless row reads as a legacy plan-day-anchored row.',
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
console.log(`mutate-v1187-d: ${MUTANTS.length} mutants against ${SUBSET.join(' + ')}\n`);

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
