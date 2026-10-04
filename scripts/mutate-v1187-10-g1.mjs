#!/usr/bin/env node
/**
 * mutate-v1187-10-g1.mjs — committed harness for v1.187.10, night charge and money.
 *
 * (C3) Ledger rows are captured only once issue + 24 h has elapsed. The PV/load actuals are
 * integrated over [issued_at, issued_at + 24 h] clipped to the capture instant, and the capture
 * was gated on the night's completion alone (window close + 16 h): a Friday 1 h window completes
 * Saturday 16:00, ~5.4 h before the forecast span ends, and the 2026-10-02 row froze 18.6 h of
 * load against a 24 h forecast (load_err −0.52, buy_err +51.09 kWh). ledgerRowsDueForCapture
 * now waits for ledgerCaptureDueMs; forecastSpanRepair resets rows at least an hour short inside
 * the re-capture horizon (retention and the 60-day sweep, less 2 days) and tags older ones.
 * Mutants C3-i..xiii.
 *
 * (C7) The owner reserve floor holds the prior through the revert readback lag
 * (isRevertSettling, the alert posture's predicate since v1.120.0). Mutants C7-i..ii.
 *
 * (C4) The greedy dispatch plan tops off from the grid only ahead of an on-peak hour in its
 * horizon, at the cheapest rate of the off-peak run before it. Mutants C4-i..iv.
 *
 * (C16) The readiness bias blocker names the sizing (forecast) error, not "delivery". C16-i.
 *
 * (C17) settings-drift calls a force-charge movement inside our window our write only at a value
 * this add-on commanded; otherwise 'panel-side'. Mutants C17-i..ix.
 *
 * Not mutated: the DOCS §9 entity rows (C35 — a documentation fix; nightChargeMqtt.test.ts reads
 * DOCS.md, and check-mutant-anchors.mjs does not resolve .md targets); the one-line log texts.
 *
 * Re-pointed elsewhere in this release: mutate-reserve-posture.mjs vii (the owner-floor condition
 * line) and mutate-force-charge.mjs xiv (classifyChange's force-charge guard).
 *
 *   node scripts/mutate-v1187-10-g1.mjs
 *
 * ★ Anchor-asserted (each anchor matches exactly once); every mutant must TYPECHECK (one that does
 *   not is reported INVALID and fails the run); each mutant names the test files that must kill it,
 *   and only those run for it (a kill is attributed, never borrowed from an unrelated file); the
 *   unmutated tree must typecheck and pass every subset first — run `npm test` for the full green
 *   baseline before reading a result. Restores in a finally block and on SIGINT/SIGTERM/SIGHUP;
 *   refuses to start over a leftover mutant marker.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = resolve(REPO, 'server');
const NLS = resolve(SERVER, 'src/nightLedgerScoring.ts');
const IDX = resolve(SERVER, 'src/index.ts');
const ACT = resolve(SERVER, 'src/nightChargeActuator.ts');
const AN = resolve(SERVER, 'src/analytics.ts');
const GATE = resolve(SERVER, 'src/nightChargeGate.ts');
const DRIFT = resolve(SERVER, 'src/settingsDrift.ts');
const FC = resolve(SERVER, 'src/nightForceCharge.ts');

const T_SPAN = 'test/ledgerForecastSpan.test.ts';
const T_FLOOR = 'test/ownerFloorAttribution.test.ts';
const T_DISPATCH = 'test/dispatchTopOff.test.ts';
const T_GATE = 'test/nightChargeGate.test.ts';
const T_FC = 'test/nightForceCharge.test.ts';

const MUTANTS = [
  /* ── C3: the forecast span ── */
  {
    id: 'C3-i. ★★★ the sweep gates on the night\'s completion only (the defect)',
    file: NLS, tests: [T_SPAN],
    find: '    if (nowMs < ledgerCaptureDueMs(spans.completeMs, row.issued_at_ms)) continue; // still in flight',
    to: '    if (nowMs < spans.completeMs) continue; /* MUTANT */',
    why: 'A Friday row is captured Saturday 16:08 on 18.6 h of load against a 24 h forecast: buy_err +11 kWh, frozen.',
  },
  {
    id: 'C3-ii. ★★ the capture instant ignores the forecast span',
    file: NLS, tests: [T_SPAN],
    find: '  return Math.max(completeMs, issuedAtMs + FORECAST_SPAN_MS);',
    to: '  return Math.max(completeMs, issuedAtMs); /* MUTANT */',
    why: 'As C3-i through the helper.',
  },
  {
    id: 'C3-iii. ★★ the forecast span is not 24 h',
    file: NLS, tests: [T_SPAN],
    find: 'export const FORECAST_SPAN_MS = 24 * HOUR_MS;',
    to: 'export const FORECAST_SPAN_MS = 18 * HOUR_MS; /* MUTANT */',
    why: 'The gate and the integration agree with each other and both disagree with the 24-slot P50.',
  },
  {
    id: 'C3-iv. ★★ the actuals span is not clipped at issue + 24 h',
    file: NLS, tests: [T_SPAN],
    find: '  return { startMs: issuedAtMs, endMs: Math.min(nowMs, issuedAtMs + FORECAST_SPAN_MS) };',
    to: '  return { startMs: issuedAtMs, endMs: nowMs }; /* MUTANT */',
    why: 'A Saturday plan captured Monday 21:00 integrates 47.5 h of load against a 24 h forecast.',
  },
  {
    id: 'C3-v. ★★ the scorer does not capture through ledgerRowsDueForCapture',
    file: IDX, tests: [T_SPAN],
    find: '  for (const { row: y, spans: s } of ledgerRowsDueForCapture(rows, nowMs, nightSpansForRow)) {',
    to: '  for (const { row: y, spans: s } of ledgerRowsDueForCapture(rows, Number.POSITIVE_INFINITY, nightSpansForRow)) { /* MUTANT */',
    why: 'Every uncaptured row, in flight or not, is captured on the next sweep.',
  },
  {
    id: 'C3-vi. ★★ the scorer integrates to the capture instant, not through forecastActualsSpan',
    file: IDX, tests: [T_SPAN],
    find: '  const fcSpan = forecastActualsSpan(y.issued_at_ms, nowMs);',
    to: '  const fcSpan = { startMs: y.issued_at_ms, endMs: nowMs }; /* MUTANT */',
    why: 'A late capture integrates past the forecast span.',
  },
  {
    id: 'C3-vii. ★★ every short row is repaired, however short (weekday rows re-scored)',
    file: NLS, tests: [T_SPAN],
    find: 'export const FORECAST_SPAN_REPAIR_MIN_SHORT_MS = HOUR_MS;',
    to: 'export const FORECAST_SPAN_REPAIR_MIN_SHORT_MS = 0; /* MUTANT */',
    why: 'Every weekday row is re-captured on the current scorer for a 0.1-0.5 h gap.',
  },
  {
    id: 'C3-viii. ★★★ the re-capture horizon ignores the 60-day sweep',
    file: NLS, tests: [T_SPAN],
    find: '  return Math.max(0, Math.min(retentionDays, sweepDays) - FORECAST_SPAN_RECAPTURE_MARGIN_DAYS) * 24 * HOUR_MS;',
    to: '  return Math.max(0, retentionDays - FORECAST_SPAN_RECAPTURE_MARGIN_DAYS) * 24 * HOUR_MS; /* MUTANT */',
    why: 'With multi-year retention a row older than the sweep is reset and never re-captured: its outcome is lost.',
  },
  {
    id: 'C3-ix. ★ a row with no stored window is repaired',
    file: NLS, tests: [T_SPAN],
    find: '  if (typeof ws !== \'number\' || typeof we !== \'number\' || !(we > ws)) return null; // no actuals measured',
    to: '  /* MUTANT */',
    why: 'A windowless row (no actuals by design) is reset and re-captured for nothing.',
  },
  {
    id: 'C3-x. ★★ the tag is not idempotent',
    file: NLS, tests: [T_SPAN],
    find: '  if (String(row.score_notes ?? \'\').includes(FORECAST_SPAN_TAG_MARKER)) return null; // already tagged',
    to: '  /* MUTANT */',
    why: 'Every boot appends the clause again.',
  },
  {
    id: 'C3-xi. ★★★ a row past the horizon is reset instead of tagged',
    file: NLS, tests: [T_SPAN],
    find: '  if (nowMs - issued <= recaptureHorizonMs) return { action: \'recapture\', shortMs };',
    to: '  if (nowMs - issued <= recaptureHorizonMs * 1000) return { action: \'recapture\', shortMs }; /* MUTANT */',
    why: 'A row whose telemetry is gone is re-captured as unscored with null actuals.',
  },
  {
    id: 'C3-xii. ★★★ the reset keeps the capture stamp',
    file: NLS, tests: [T_SPAN],
    find: '  return {\n    outcome_captured_at_ms: null,\n    actual_pv_kwh: null,',
    to: '  return { /* MUTANT */\n    actual_pv_kwh: null,',
    why: 'The sweep skips captured rows: a "reset" row is never re-captured, its outcome nulled for good.',
  },
  {
    id: 'C3-xiii. ★★ the boot repair is not run',
    file: IDX, tests: [T_SPAN],
    find: '    repairShortForecastSpanOutcomes(); // v1.187.10 — before the sweep below re-captures them',
    to: '    /* MUTANT */',
    why: 'The 10-02 row keeps its truncated actuals.',
  },

  /* ── C7: the owner floor through the revert readback lag ── */
  {
    id: 'C7-i. ★★★ the owner floor falls to the device echo at the revert ACK (the defect)',
    file: ACT, tests: [T_FLOOR],
    find: '  if (isReserveArbitrageRaised(state) || isRevertSettling(state, liveReservePct, nowMs)) {',
    to: '  if (isReserveArbitrageRaised(state)) { /* MUTANT */',
    why: 'For ~90 s after each revert the runway measures against 50%: "reserve in 5.6 h"; on a grid-loss revert a false "at the reserve floor" critical.',
  },
  {
    id: 'C7-ii. ★★ the snapshot push hands the helper a stale clock',
    file: IDX, tests: [T_FLOOR],
    find: '  analytics.pushOwnerFloor(ownerReserveFloorPct(nightActuationMem, live, Date.now()));',
    to: '  analytics.pushOwnerFloor(ownerReserveFloorPct(nightActuationMem, live, 0)); /* MUTANT */',
    why: 'The per-snapshot push never sees a settling revert, so the worker floor drops to 50 on the next snapshot.',
  },

  /* ── C4: the dispatch top-off ── */
  {
    id: 'C4-i. ★★★ the top-off branch fires in any off-peak hour (the defect)',
    file: AN, tests: [T_DISPATCH],
    find: '      } else if (topOff[i] && socKwh < targetPrePeakKwh) {',
    to: '      } else if (!onPeak && socKwh < targetPrePeakKwh) { /* MUTANT */',
    why: 'A weekend horizon imports 12 h at 16.91 c with the pack at 76-79%.',
  },
  {
    id: 'C4-ii. ★★ a run with no on-peak after it tops off',
    file: AN, tests: [T_DISPATCH],
    find: '  return out; // an off-peak run with no on-peak after it inside the horizon never tops off',
    to: '  for (let k = runStart; k < hours.length; k++) out[k] = true; /* MUTANT */\n  return out;',
    why: 'As C4-i: no peak ahead, still imports.',
  },
  {
    id: 'C4-iii. ★★ the cheapest tier is not required',
    file: AN, tests: [T_DISPATCH],
    find: '    for (let k = runStart; k < i; k++) if (hours[k].rateCents <= cheapest + 1e-9) out[k] = true;',
    to: '    for (let k = runStart; k < i; k++) out[k] = true; /* MUTANT */',
    why: 'A weekday evening imports 19:00-23:00 at 16.91 c ahead of the 12.59 c overnight tier.',
  },
  {
    id: 'C4-iv. ★ the run does not restart after an on-peak hour',
    file: AN, tests: [T_DISPATCH],
    find: '    runStart = i + 1;',
    to: '    /* MUTANT */',
    why: 'A second peak\'s run is judged against the first run\'s cheaper tier, and an on-peak hour itself is marked.',
  },

  /* ── C16: the bias blocker ── */
  {
    id: 'C16-i. ★★ the blocker says "delivery bias" again',
    file: GATE, tests: [T_GATE],
    find: '      `sizing bias ${buyBiasKwh != null ? buyBiasKwh.toFixed(2) : \'n/a\'} kWh outside the slight-over-buy band [${BUY_BIAS_MIN_KWH}, ${BUY_BIAS_MAX_KWH}] `',
    to: '      `delivery bias ${buyBiasKwh != null ? buyBiasKwh.toFixed(2) : \'n/a\'} kWh outside the slight-over-buy band [${BUY_BIAS_MIN_KWH}, ${BUY_BIAS_MAX_KWH}] ` /* MUTANT */',
    why: 'The readiness blocker points remediation at the actuator when the bias is load over-forecast.',
  },

  /* ── C17: settings-drift attribution ── */
  {
    id: 'C17-i. ★★★ every force-charge movement in the window is "our write" again (the defect)',
    file: DRIFT, tests: [T_FC],
    find: '    return forceChargeCommanded(c, fc[1] != null ? Number(fc[1]) : null, act.forceChargeCommands) ? \'own-write\' : \'panel-side\';',
    to: '    return forceChargeCommanded(c, fc[1] != null ? Number(fc[1]) : null, act.forceChargeCommands) || true ? \'own-write\' : \'panel-side\'; /* MUTANT */',
    why: 'The panel\'s own ceiling stop is logged as the add-on\'s OFF, minutes before it was issued.',
  },
  {
    id: 'C17-ii. ★★ an OFF is ours before it was issued',
    file: DRIFT, tests: [T_FC],
    find: '  if (c.to === \'FORCE_CHARGE_OFF\') return cmd.offIssued;',
    to: '  if (c.to === \'FORCE_CHARGE_OFF\') return true; /* MUTANT */',
    why: 'The 10-02 04:25 lines: the backstop\'s stop attributed to the add-on.',
  },
  {
    id: 'C17-iii. ★★ an ON after our OFF is ours',
    file: DRIFT, tests: [T_FC],
    find: '  if (c.to === \'FORCE_CHARGE_ON\') return !cmd.offIssued;',
    to: '  if (c.to === \'FORCE_CHARGE_ON\') return true; /* MUTANT */',
    why: 'A manual Charge Now after our OFF is logged as the add-on\'s write.',
  },
  {
    id: 'C17-iv. ★★ a slot we never switched on is ours',
    file: DRIFT, tests: [T_FC],
    find: '  if (cmd.onSlots == null || !cmd.onSlots.includes(slot)) return false;',
    to: '  if (cmd.onSlots == null) return false; /* MUTANT */',
    why: 'An operator switching on slot 3 during a 1-2 slot force-charge is logged as ours.',
  },
  {
    id: 'C17-v. ★★ any ceiling value is ours',
    file: DRIFT, tests: [T_FC],
    find: '  if (slot == null) return typeof c.to === \'number\' && cmd.ceilingPcts.includes(c.to); // foceChargeHight',
    to: '  if (slot == null) return typeof c.to === \'number\'; /* MUTANT */',
    why: 'A ceiling moved to a value never written is logged as ours.',
  },
  {
    id: 'C17-vi. ★★ the restore value is ours before the restore was issued',
    file: FC, tests: [T_FC],
    find: '  if (s.forceChargeCeilingRestoreLastAttemptMs != null && s.forceChargeCeilingPriorPct != null) {',
    to: '  if (s.forceChargeCeilingPriorPct != null) { /* MUTANT */',
    why: 'The panel ceiling going back to 100 mid-night (an operator) is logged as our restore.',
  },
  {
    id: 'C17-vii. ★ the synced ceiling is the raw target, not the value written',
    file: FC, tests: [T_FC],
    find: '    ceilingPcts.push(desiredForceChargeCeilingPct(s.forceChargeCeilingPct));',
    to: '    ceilingPcts.push(s.forceChargeCeilingPct); /* MUTANT */',
    why: 'The 86.6% target synced as 87 is never matched: our own ceiling write is logged panel-side.',
  },
  {
    id: 'C17-viii. ★★ "OFF issued" read from the OFF verify',
    file: FC, tests: [T_FC],
    find: '  return { onSlots, offIssued: s.forceChargeOffAtMs != null, ceilingPcts };',
    to: '  return { onSlots, offIssued: s.forceChargeOffVerifiedAtMs != null, ceilingPcts }; /* MUTANT */',
    why: 'Our OFF readback, which lands before the verify, is logged panel-side.',
  },
  {
    id: 'C17-ix. ★★ the drift tick classifies without the commanded writes',
    file: IDX, tests: [T_FC],
    find: '        forceChargeCommands: forceChargeCommandsOf(act),',
    to: '        forceChargeCommands: null, /* MUTANT */',
    why: 'Every force-charge movement, ours included, is logged as panel-side.',
  },
];

// Built with join() on purpose: check-mutant-anchors.mjs reads a path.resolve call on SERVER
// with a single string literal as a mutant TARGET file, and CI's checkout has no node_modules.
const TSC = join(SERVER, 'node_modules', '.bin', 'tsc');

/** true = the command passed; false = it ran and failed (its output is kept for the kill report).
 *  Throws if it could not run at all (killed by a signal, missing binary). */
let lastOutput = '';
function passes(cmd, args) {
  try {
    execFileSync(cmd, args, { cwd: SERVER, stdio: 'pipe', maxBuffer: 256 * 1024 * 1024 });
    lastOutput = '';
    return true;
  } catch (e) {
    if (typeof e?.status === 'number' && e?.signal == null) {
      lastOutput = `${e.stdout ?? ''}\n${e.stderr ?? ''}`;
      return false;
    }
    throw e;
  }
}
const typechecks = () => passes(TSC, ['--noEmit', '-p', 'tsconfig.test.json']);
const testsPass = (files) => passes('node', ['--import', 'tsx', '--test', '--test-reporter=spec', ...files]);
/** The failing test names from the spec reporter's summary (deduplicated). */
function failingTests(out) {
  const at = out.lastIndexOf('failing tests:');
  const names = new Set();
  for (const line of (at >= 0 ? out.slice(at) : out).split('\n')) {
    const m = /^\s*✖ (.+?)(?: \([\d.]+m?s\))?$/.exec(line);
    if (m && m[1] !== 'failing tests:') names.add(m[1]);
  }
  return [...names];
}

const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const selected = only ? MUTANTS.filter((m) => m.id.startsWith(only)) : MUTANTS;
if (only && selected.length === 0) {
  console.error(`\nABORT: --only ${only} selects no mutant.`);
  process.exit(2);
}

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
  if (!m.to.includes('/* MUTANT */')) {
    console.error(`\nABORT: "${m.id}" carries no /* MUTANT */ marker, so a leftover could not be detected.`);
    process.exit(2);
  }
}
const allSubsets = [...new Set(MUTANTS.flatMap((m) => m.tests))];
if (!typechecks() || !testsPass(allSubsets)) {
  console.error('\nABORT: the UNMUTATED tree fails to typecheck or fails a subset. Fix the baseline first.');
  console.error(failingTests(lastOutput).join('\n') || lastOutput.slice(-2000));
  process.exit(2);
}

let killed = 0;
const survivors = [];
const invalid = [];
console.log(`mutate-v1187-10-g1: ${selected.length} mutants (baseline: typecheck + ${allSubsets.join(', ')} green)\n`);

try {
  for (const m of selected) {
    const original = originals.get(m.file);
    const mutated = original.replace(m.find, m.to);
    writeFileSync(m.file, mutated);
    // A mutant that does not typecheck proves nothing about the tests: report it, never count it.
    if (!typechecks()) {
      writeFileSync(m.file, original);
      invalid.push(m);
      console.log(`  INVALID  ${m.id}\n           ↳ the mutant does not typecheck — fix the mutant`);
      continue;
    }
    const died = !testsPass(m.tests);
    const by = died ? failingTests(lastOutput) : [];
    writeFileSync(m.file, original);
    if (died) {
      killed++;
      console.log(`  KILLED   ${m.id}`);
      for (const t of by.slice(0, 4)) console.log(`           ✖ ${t}`);
      if (by.length > 4) console.log(`           … and ${by.length - 4} more`);
    } else { survivors.push(m); console.log(`  SURVIVED ${m.id}\n           ↳ ${m.why}`); }
  }
} finally {
  restoreAll();
}

console.log(`\n${killed}/${selected.length} mutants killed`);
if (invalid.length) {
  console.log('\nINVALID — these mutants do not typecheck and were not run:');
  for (const s of invalid) console.log(`  - ${s.id}`);
}
if (survivors.length) {
  console.log('\nSURVIVORS — the named tests do not constrain these behaviours:');
  for (const s of survivors) console.log(`  - ${s.id}\n      ${s.why}`);
}
if (invalid.length || survivors.length) process.exit(1);
console.log('post-run: tree restored');
