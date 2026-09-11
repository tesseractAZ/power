#!/usr/bin/env node
/**
 * mutate-absence-evidence.mjs — committed mutation harness for v1.140.0's four
 * evidence gates (R1, R2, R3, R4).
 *
 * WHY COMMITTED: every one of these is the same shape — "absence from a filtered
 * collection is treated as evidence" — and every one of them fails SILENTLY. The
 * add-on reports itself healthy, the push says the fault cleared, the ledger says
 * the write was verified, the warranty record is simply gone. Nothing throws and
 * nothing is logged, which is why three of the four had to be found by reading
 * code rather than by watching the system.
 *
 *   node scripts/mutate-absence-evidence.mjs
 *
 * ★ Every mutation is ANCHOR-ASSERTED: if `find` is not present exactly once the
 *   harness ABORTS rather than reporting a green run against an unmutated tree.
 * ★ Mutates the working tree in place, restoring in a finally block. Do not run
 *   git add/commit/checkout while it is running.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = resolve(REPO, 'server');
const SNAP = resolve(SERVER, 'src/snapshot.ts');
const MEMB = resolve(SERVER, 'src/shp2Membership.ts');
const MON = resolve(SERVER, 'src/alertMonitor.ts');
const LATCH = resolve(SERVER, 'src/defectivePackLatch.ts');
const ALERTS = resolve(SERVER, 'src/alerts.ts');

const SUBSET = [
  'test/pollHealthAttribution.test.ts',
  'test/shp2ReadbackFreshness.test.ts',
  'test/orphanedNotified.test.ts',
  'test/defectivePackLatch.test.ts',
  'test/alertResolveEvidence.test.ts',
];

const MUTANTS = [
  // ── R1: the alarm-path roster ──────────────────────────────────────────────
  {
    id: 'i. ★★★ R1: the roster goes back to a projection filter (v1.138.0’s own hole)',
    file: SNAP,
    find: '  return shp2Panels(devices).sns;',
    to: "  return Object.keys(devices).filter((sn) => (devices[sn] as any)?.projection?.kind === 'shp2'); /* MUTANT */",
    why: 'A projection only exists after a SUCCESSFUL fetch. Restart while the SHP2 is dark and the roster is [] for the whole window — the telemetry-blind CRITICAL never arms.',
  },
  {
    id: 'ii. R1: the identity match is tightened to equality',
    file: MEMB,
    find: "    const byName = (d.productName ?? '').toLowerCase().includes('smart home panel');",
    to: "    const byName = (d.productName ?? '').toLowerCase() === 'smart home panel'; /* MUTANT */",
    why: 'The live productName is "Smart Home Panel 2"; an equality test silently drops the only panel in the fleet.',
  },
  // ── R3: the control readback ───────────────────────────────────────────────
  {
    id: 'iii. ★★★ R3: an offline panel counts as a live readback',
    file: MEMB,
    find: '  if (!d || d.online !== true) return false;',
    to: '  if (!d) return false; /* MUTANT */',
    why: 'THE DEFECT: a frozen projection drives applyFailed ("the write NEVER TOOK EFFECT") or revertFailed — a spoken bilingual CRITICAL broadcast — from a sample hours old.',
  },
  {
    id: 'iv. R3: staleness stops mattering',
    file: MEMB,
    // v1.142.0 — repointed: the readback is now keyed on lastQuotaAtMs and the
    // early-return shape changed. The property is identical.
    find: '  if (nowMs - lu > staleMs) return false;',
    to: '  /* MUTANT */',
    why: 'An online-but-wedged panel keeps serving its last sample; strict-equality readback verdicts are then manufactured from it.',
  },
  {
    id: 'v. R3: lastUpdated 0 reads as a real sample',
    file: MEMB,
    find: '  if (typeof lu !== \'number\' || !Number.isFinite(lu) || lu <= 0) return false;',
    to: "  if (typeof lu !== 'number') return false; /* MUTANT */",
    why: 'Four devices report online:true with lastUpdated:0 right now. Zero must never mean "epoch, therefore a reading".',
  },
  {
    id: 'vi. ★ R3: the live actuator stops gating its read',
    file: resolve(SERVER, 'src/index.ts'),
    find: "    shp2 && shp2.projection?.kind === 'shp2' && shp2ReadbackFresh(shp2, nowMs)",
    to: "    shp2 && shp2.projection?.kind === 'shp2'  /* MUTANT */",
    why: 'The predicate stays correct and the actuator inert — the wire-it-to-the-production-bridge failure.',
  },
  // ── R2: the boot orphan sweep ──────────────────────────────────────────────
  {
    id: 'vii. ★★★ R2: the evidence gate is removed from the sweep',
    file: MON,
    find: '    if (p.unevaluable(id, rec)) {',
    to: '    if (false) { /* MUTANT */',
    why: 'THE DEFECT: on a restart while a Core is cloud-dark, every standing fault on it is resolve-pushed to the phone and its HA card dismissed — including CRITICALs that never cleared.',
  },
  {
    id: 'viii. R2: the evidence gate moves ahead of the owed test',
    file: MON,
    find: '    if (!owed) { drop.push(id); continue; }\n    if (p.unevaluable(id, rec)) {',
    to: '    if (p.unevaluable(id, rec)) { /* MUTANT */',
    why: 'Never-pushed records (spares, annunciate:false, downgrades) would be held forever — the sweep stops collecting for exactly the noisiest families.',
  },
  {
    id: 'ix. ★ R2: hold expiry RESOLVES instead of dropping',
    file: MON,
    find: '      (p.nowMs >= p.holdUntilMs ? drop : hold).push(id);',
    to: '      (p.nowMs >= p.holdUntilMs ? resolve : hold).push(id); /* MUTANT */',
    why: 'The deadline would manufacture the very false all-clear the hold exists to prevent, just six hours later.',
  },
  {
    id: 'x. R2: the sweep latches even with orphans held',
    file: MON,
    find: '      orphanSweepDone = hold.length === 0;',
    to: '      orphanSweepDone = true; /* MUTANT */',
    why: 'Held records are stranded after the first tick and never resolve even once their device returns.',
  },
  {
    id: 'xi. R2: sourceSn stops being persisted',
    file: MON,
    find: "          persistedNotified.set(a.id, { ts: now, sent: outcome === 'sent', sev: a.severity, title: a.title, sourceSn: a.sourceSn });",
    to: "          persistedNotified.set(a.id, { ts: now, sent: outcome === 'sent', sev: a.severity, title: a.title }); /* MUTANT */",
    why: 'The id-scan fallback returns null for shp2-src-err-* and friends, so the alarm data source’s own alerts lose their gate — the SN-less hole v1.78.0 closed once already.',
  },
  {
    id: 'xii. R2: the DPU loop stops stamping its source device',
    file: ALERTS,
    find: '    for (let i = dpuStart; i < out.length; i++) if (!out[i].sourceSn) out[i].sourceSn = d.sn;',
    to: '    /* MUTANT */',
    why: 'dpu-err-* / vdiff-crit-* would persist with no sourceSn, so the gate has nothing to consult on a restart.',
  },
  // ── R4: the defective-pack latch ───────────────────────────────────────────
  {
    id: 'xiii. ★★★ R4: retirement stops requiring an evaluable chassis',
    file: LATCH,
    find: '    if (!p.evaluableDeviceSns.has(host)) {',
    to: '    if (false) { /* MUTANT */',
    why: 'THE DEFECT: a Core powered down and boxed FOR RMA is exactly the Core that stays dark, so the warranty diagnosis it was pulled for is what gets deleted.',
  },
  {
    id: 'xiv. ★ R4: the host key reverts to the FROZEN deviceSn',
    file: LATCH,
    find: '    const host = lastSeenDeviceSn.get(sn) ?? rec.deviceSn;',
    to: '    const host = rec.deviceSn; /* MUTANT */',
    why: 'rec.deviceSn is frozen at first confirmation and this plant’s history is a pack that MOVED chassis (08-20). A record whose original Core is gone could then never retire.',
  },
  {
    id: 'xv. R4: the absolute backstop is removed',
    file: LATCH,
    find: '      if (p.nowMs - frozen <= DEFECTIVE_PACK_ABSOLUTE_RETIRE_MS) {',
    to: '      if (true) { /* MUTANT */',
    why: 'The realistic RMA ships the chassis WITH the pack, so its host may never return — the record could never retire, and a repaired pack under the same serial would re-attach an un-muteable standing warning.',
  },
  {
    id: 'xvi. R4: an evaluable chassis stops clearing the frozen clock',
    file: LATCH,
    find: '      frozenSinceMs.delete(sn);\n    }\n\n    if (p.nowMs - seen > DEFECTIVE_PACK_ABSENT_RETIRE_MS) {',
    to: '      void 0; /* MUTANT */\n    }\n\n    if (p.nowMs - seen > DEFECTIVE_PACK_ABSENT_RETIRE_MS) {',
    why: 'The backstop would measure cumulative rather than CONTINUOUS darkness, retiring a record whose chassis has been healthy all along.',
  },
  {
    id: 'xvii. ★ R4: the evaluable set drifts from the loop gate',
    file: ALERTS,
    find: '    evaluableDeviceSns: new Set(dpus.filter(isDpuEvaluable).map((d) => d.sn)),',
    to: '    evaluableDeviceSns: new Set(dpus.map((d) => d.sn)), /* MUTANT */',
    why: 'The gate would be built from a DIFFERENT filter than the loop that refreshes presence — reintroducing the exact shape the fix closes.',
  },
  {
    id: 'xviii. R4: the retirement log line is dropped',
    file: LATCH,
    find: '      console.warn(`defective-pack: RETIRING confirmed record ${JSON.stringify(rec)}`);',
    to: '      /* MUTANT */',
    why: 'A warranty diagnosis destroyed with zero breadcrumb — which is why this had to be settled by code reading rather than by looking.',
  },
];

function run(files) {
  execFileSync('npm', ['test', '--silent', '--', ...files], { cwd: SERVER, stdio: 'pipe' });
}

const originals = new Map();
for (const m of MUTANTS) if (!originals.has(m.file)) originals.set(m.file, readFileSync(m.file, 'utf8'));

let killed = 0;
const survivors = [];
console.log(`mutate-absence-evidence: ${MUTANTS.length} mutants against ${SUBSET.length} test files\n`);

for (const m of MUTANTS) {
  const original = originals.get(m.file);
  const hits = original.split(m.find).length - 1;
  if (hits !== 1) {
    console.error(`\nABORT: anchor for "${m.id}" matched ${hits} times, expected exactly 1.`);
    console.error('The source moved. Fix the anchor — do NOT report this run as green.');
    for (const [f, s] of originals) writeFileSync(f, s);
    process.exit(2);
  }
  try {
    writeFileSync(m.file, original.replace(m.find, m.to));
    let died = false;
    try { run(SUBSET); } catch { died = true; }
    if (!died) { try { run([]); } catch { died = true; } }
    if (died) { killed++; console.log(`  KILLED   ${m.id}`); }
    else { survivors.push(m); console.log(`  SURVIVED ${m.id}\n           ↳ ${m.why}`); }
  } finally {
    writeFileSync(m.file, original);
  }
}

console.log(`\n${killed}/${MUTANTS.length} mutants killed`);
if (survivors.length) {
  console.log('\nSURVIVORS — the suite does not constrain these behaviours:');
  for (const s of survivors) console.log(`  - ${s.id}\n      ${s.why}`);
  process.exit(1);
}
console.log('post-run: tree restored');
