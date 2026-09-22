#!/usr/bin/env node
/**
 * mutate-alarm-transients.mjs — committed harness for the v1.174.0 transient-alarm guards:
 * the MPPT string error-code debounce (server/src/alerts.ts + snapshot.ts + mppt.ts) and
 * the cell-imbalance speak hold (server/src/broadcast.ts).
 *
 * WHY COMMITTED: both guards are invisible when they break. A dropped debounce does not
 * fail a build or a report — it speaks a warning over the house for 60 s at sunrise and
 * then the evidence clears itself (2026-09-22 06:58 and 07:33; 2026-08-30 06:43). The
 * store-side half is subtler still: a clock that counts a benign standby code overnight
 * looks identical in every test that only advances time forward with the string
 * producing, and would let the very blip this release fixes straight back through.
 *
 *   node scripts/mutate-alarm-transients.mjs
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
const ALERTS = resolve(SERVER, 'src/alerts.ts');
const SNAP = resolve(SERVER, 'src/snapshot.ts');
const MPPT = resolve(SERVER, 'src/mppt.ts');
const BC = resolve(SERVER, 'src/broadcast.ts');

const SUBSET = ['test/mpptErrDebounce.test.ts', 'test/imbalanceSpeakHold.test.ts'];

const MUTANTS = [
  /* ── the MPPT string error-code debounce ──────────────────────────────── */
  {
    id: 'i. ★★★ the HV guard is gone — producing is sufficient again',
    file: ALERTS,
    find: "        && !mpptErrDebounced(connectivity, d.sn, 'hv', p.pvHighErrCode ?? 0, now)) {",
    to: '        ) { /* MUTANT */',
    why: 'The sunrise ramp carries the benign standby code at 407 W / 1.38 A; the house is told "high priority alarm, high voltage M P P T error code" for a condition that is gone one tick later.',
  },
  {
    id: 'ii. ★★ the LV guard is gone (a one-sided fix)',
    file: ALERTS,
    find: "        && !mpptErrDebounced(connectivity, d.sn, 'lv', p.pvLowErrCode ?? 0, now)) {",
    to: '        ) { /* MUTANT */',
    why: 'The LV string reports its own standby code (177 at sunset); guarding only HV leaves half the false alarms in place.',
  },
  {
    id: 'iii. ★★★ the onset clock ignores production — a dark string banks debounce time',
    file: SNAP,
    find: '      if (code === 0 || !mpptProducing(watts, amps)) { this.mpptErrOnsetByKey.delete(key); continue; }',
    to: '      if (code === 0) { this.mpptErrOnsetByKey.delete(key); continue; } /* MUTANT */',
    why: 'A standby code that stands all night ages past the window while making no watts, so the first producing tick at sunrise fires instantly — the debounce is present but inert, which is worse than absent because it reads as fixed.',
  },
  {
    id: 'iv. ★★ the window is zero',
    file: ALERTS,
    find: 'const MPPT_ERR_DEBOUNCE_MS = DPU_ERR_DEBOUNCE_MS;',
    to: 'const MPPT_ERR_DEBOUNCE_MS = 0; /* MUTANT */',
    why: 'Every blip passes; the guard exists in the code and does nothing.',
  },
  {
    id: 'v. ★★ a changed code inherits the previous code’s elapsed window',
    file: SNAP,
    find: '      if (!prev || prev.code !== code) this.mpptErrOnsetByKey.set(key, { code, sinceMs: this.now() });',
    to: '      if (!prev) this.mpptErrOnsetByKey.set(key, { code, sinceMs: this.now() }); /* MUTANT */',
    why: 'A genuinely different fault appearing under a long-standing benign code alarms with no confirmation at all, and its detail line reports the new code against the old code’s clock.',
  },
  {
    id: 'vi. ★ the onset is keyed per DEVICE, so the two strings share one clock',
    file: SNAP,
    find: '      const key = `${sn}:${channel}`;',
    to: '      const key = `${sn}`; /* MUTANT */',
    why: 'The LV channel (usually code 0) deletes the HV channel’s onset on every ingest, so the HV clock never survives to its window and HV alarms are silently lost.',
  },
  {
    id: 'vii. ★★ the watt floor is removed from the producing test',
    file: MPPT,
    find: '  if (watts == null || watts <= MPPT_WATT_FLOOR) return false;',
    to: '  if (watts == null) return false; /* MUTANT */',
    why: 'The sunset shed (0 W with a 0.275 A shutdown trickle) counts as producing again — the v0.9.81 false-alarm mode, back.',
  },
  /* ── the cell-imbalance speak hold ────────────────────────────────────── */
  {
    id: 'viii. ★★★ the hold is not wired into the broadcast tick',
    file: BC,
    find: '      .filter((a) => !heldForImbalanceConfirm(a, tickNow, getAlertOnset(a.id)));',
    to: '      ; /* MUTANT */',
    why: 'The helper is exported, unit-tested and dead. A six-minute cell-spread excursion speaks over the house exactly as it did at 21:14 on 2026-09-21.',
  },
  {
    id: 'ix. ★★★ the hold swallows the CRITICAL imbalance too',
    file: BC,
    find: "  if (alert.severity !== 'warning') return false;",
    to: '  /* MUTANT */',
    why: 'A critical cell imbalance — a genuine battery emergency — is silenced for ten minutes. A comfort guard must never delay a critical.',
  },
  {
    id: 'x. ★★ an unknown onset speaks instead of holding',
    file: BC,
    find: '  if (onsetMs == null) return true;',
    to: '  if (onsetMs == null) return false; /* MUTANT */',
    why: 'The onset sidecar is best-effort (an unwritable state dir returns undefined), so the hold silently degrades to the old speak-at-onset behaviour on exactly the hosts where it cannot be noticed.',
  },
  {
    id: 'xi. ★ the hold window is zero',
    file: BC,
    find: 'export const IMBALANCE_SPEAK_HOLD_MS = 10 * 60_000;',
    to: 'export const IMBALANCE_SPEAK_HOLD_MS = 0; /* MUTANT */',
    why: 'Present, exported, wired — and holds nothing.',
  },
  {
    id: 'xii. ★ the peer-outlier report of the same event is not held',
    file: BC,
    find: "export const IMBALANCE_SPEAK_HOLD_PREFIXES = ['vdiff-warn-', 'peer-voldiff-'] as const;",
    to: "export const IMBALANCE_SPEAK_HOLD_PREFIXES = ['vdiff-warn-'] as const; /* MUTANT */",
    why: 'The same excursion is reported twice, 40 s apart; holding one and speaking the other keeps the announcement and merely renames it.',
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
console.log(`mutate-alarm-transients: ${MUTANTS.length} mutants against ${SUBSET.join(' + ')}\n`);

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
