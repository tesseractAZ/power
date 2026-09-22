#!/usr/bin/env node
/**
 * mutate-blind-remediation.mjs — committed harness for v1.166.0 REMEDIATE FIRST, ALARM
 * ONLY IF IT FAILS (server/src/blindRemediation.ts, the shared heal budget in
 * sessionSelfHeal.ts, the gate in alertMonitor.ts and the hooks in index.ts).
 *
 * WHY COMMITTED: this gates the telemetry-blind CRITICAL — the alarm that says the
 * system cannot see. Owner decision (2026-09-17): sound it only once an immediate
 * remediation has been tried and has failed. Each rail below is one comparison wide,
 * and each failure mode is either a false alarm the owner asked to be rid of, or —
 * worse — a genuine blind alarm that never sounds. Each mutant must die by a named
 * assertion.
 *
 *   node scripts/mutate-blind-remediation.mjs
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
const BR = resolve(SERVER, 'src/blindRemediation.ts');
const SH = resolve(SERVER, 'src/sessionSelfHeal.ts');
const MON = resolve(SERVER, 'src/alertMonitor.ts');
const IDX = resolve(SERVER, 'src/index.ts');
const BC = resolve(SERVER, 'src/broadcast.ts');

const SUBSET = ['test/blindRemediation.test.ts', 'test/blindPanelWording.test.ts'];

const MUTANTS = [
  {
    id: 'v1.173.0 ★★ the Telemetry stale warning speaks again',
    file: BC,
    find: "      !a.id.startsWith('stale-'),",
    to: '      true, /* MUTANT */',
    why: 'A yellow is spoken ~20 s after every restart, and at every stale episode — before the remediation runs.',
  },
  {
    id: 'v1.173.0 ★★★ the rate-collapse warning speaks again at the onset',
    file: BC,
    find: "      !a.id.startsWith('msg-rate-floor-'),",
    to: '      true, /* MUTANT */',
    why: 'Every cloud stale-shadow episode speaks a yellow ~4 min before the remediation even starts — against the owner’s remediate-first rule.',
  },
  {
    id: 'i. ★★★ the hold never expires (a blind alarm that never sounds)',
    file: BR,
    find: '  if (s.remediatedAtMs != null && nowMs - s.remediatedAtMs < BLIND_REMEDIATION_VERIFY_MS) {',
    to: '  if (s.remediatedAtMs != null) { /* MUTANT */',
    why: 'A remediation that fails holds the telemetry-blind CRITICAL forever — the system is blind and says nothing. The one failure worse than a false alarm.',
  },
  {
    id: 'ii. ★★★ it holds even when NO remediation is available',
    file: BR,
    find: "      : { phase: 'unavailable', hold: false, triggerHeal: false, next: { episodeStartMs: nowMs, remediatedAtMs: null } };",
    to: "      : { phase: 'unavailable', hold: true, triggerHeal: false, next: { episodeStartMs: nowMs, remediatedAtMs: null } }; /* MUTANT */",
    why: 'With the heal budget spent there is nothing to wait for, yet the alarm is silenced — "alarm after remediation failed" becomes "never alarm".',
  },
  {
    id: 'iii. ★★★ the remediation is not fired immediately',
    file: BR,
    find: "      ? { phase: 'remediating', hold: true, triggerHeal: true, next: { episodeStartMs: nowMs, remediatedAtMs: nowMs } }",
    to: "      ? { phase: 'remediating', hold: true, triggerHeal: false, next: { episodeStartMs: nowMs, remediatedAtMs: nowMs } } /* MUTANT */",
    why: 'The alarm is held for a remediation that never happens — five silent minutes bought for nothing, then the 20-minute healer again.',
  },
  {
    id: 'iv. ★★ the remediation re-fires every tick of an episode',
    file: BR,
    find: "    return { phase: 'remediating', hold: true, triggerHeal: false, next: s };",
    to: "    return { phase: 'remediating', hold: true, triggerHeal: true, next: s }; /* MUTANT */",
    why: 'Five MQTT rebuilds in five minutes — the 08-08 flap-storm thrash the heal budget exists to prevent, spent in one episode.',
  },
  {
    id: 'v. ★★★ the gate is not applied to the alert',
    file: MON,
    find: '        if (remediation.hold) for (const a of blindAlerts) a.annunciate = false;',
    to: '        /* MUTANT */',
    why: 'The remediation runs but the alarm still speaks at once — the owner\'s rule is not in force at all.',
  },
  {
    id: 'vi. ★★★ with no remedy registered it holds (fails toward SILENCE)',
    file: BR,
    find: '  try { healAvailable = hooks?.canHeal() === true; } catch { healAvailable = false; }',
    to: '  try { healAvailable = true; } catch { healAvailable = false; } /* MUTANT */',
    why: 'A boot-order slip or a missing registration silences the blind alarm with no remediation behind it.',
  },
  {
    id: 'vii. ★★ a remedy that cannot start still holds',
    file: BR,
    find: "      lastPhase = 'unavailable';\n      return { hold: false, phase: 'unavailable' };",
    to: "      lastPhase = 'unavailable'; /* MUTANT */",
    why: 'The MQTT rebuild throws, nothing is repairing anything, and the alarm is held for five minutes anyway.',
  },
  {
    id: 'viii. ★★ the heal budget is not shared (no daily cap)',
    file: SH,
    find: '  if (inWindow >= cfg.maxPerDay) return false;',
    to: '  /* MUTANT */',
    why: 'Blind remediations bypass the six-a-day cap — a flapping cloud drives unbounded session rebuilds.',
  },
  {
    id: 'ix. ★★ no minimum gap between remediations',
    file: SH,
    find: '  if (state.lastHealMs != null && nowMs - state.lastHealMs < BLIND_REMEDIATION_MIN_GAP_MS) return false;',
    to: '  /* MUTANT */',
    why: 'A remedy that did not hold is tried again and again, holding the alarm each time — a recurring blind condition never sounds promptly.',
  },
  {
    id: 'x. ★★★ the rebuild runs BEFORE the budget is persisted',
    file: IDX,
    find: '    saveSelfHealState(selfHealState); // persist the budget BEFORE the rebuild\n    app.log.warn(`self-heal: ${reason}',
    to: '    /* MUTANT */\n    app.log.warn(`self-heal: ${reason}',
    why: 'A crash mid-rebuild hands back a free heal: the cap is really "six per process lifetime", the v1.93.0 defect.',
  },
  {
    id: 'xi. ★★ a critical held silent by policy leaves no trace',
    file: MON,
    find: "    a.severity === 'critical' && a.annunciate === false && a.id !== TELEMETRY_BLIND_ALERT_ID);",
    to: "    false && a.id !== TELEMETRY_BLIND_ALERT_ID); /* MUTANT */",
    why: 'A bench-spare critical is on-screen but silent, and the log gives no sign it was a choice — "chose not to" reads as "broke".',
  },
  // ── pre-merge review fixes ──
  {
    id: 'xii. ★★★ "All clear" is spoken while the blind alert is held',
    file: BC,
    find: '    a.severity === \'critical\' && (a.annunciate !== false || a.id === TELEMETRY_BLIND_ALERT_ID));',
    to: '    a.severity === \'critical\' && a.annunciate !== false); /* MUTANT */',
    why: 'A warning clearing during the hold announces "All clear. All stations report normal." while the system is blind.',
  },
  {
    id: 'xiii. ★★ the hold deadline stretches to 50 minutes',
    file: BR,
    find: 'export const BLIND_REMEDIATION_VERIFY_MS = 5 * 60_000;',
    to: 'export const BLIND_REMEDIATION_VERIFY_MS = 50 * 60_000; /* MUTANT */',
    why: 'A genuine blind alarm is silenced for 50 minutes — the owner was promised at most 5.',
  },
  {
    id: 'xiv. ★★ the minimum gap drops to zero',
    file: SH,
    find: 'export const BLIND_REMEDIATION_MIN_GAP_MS = 15 * 60_000;',
    to: 'export const BLIND_REMEDIATION_MIN_GAP_MS = 0; /* MUTANT */',
    why: 'A remedy that just failed to hold is retried at once, holding a recurring blind alarm again and again.',
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
console.log(`mutate-blind-remediation: ${MUTANTS.length} mutants against ${SUBSET.join(' + ')}\n`);

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
