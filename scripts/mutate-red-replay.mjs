#!/usr/bin/env node
/**
 * mutate-red-replay.mjs — committed mutation harness for the v1.64.0 post-restart
 * RED replay gate (server/src/redReplayGate.ts, the identity seam in
 * conditionFromAlerts, and the fault sub-identity in alerts.ts).
 *
 * WHY THIS IS COMMITTED, not run ad hoc: "the tests would catch it" is a claim,
 * and a claim about an ALARM path has to be reproducible. Each mutant below is a
 * defect a reviewer might reasonably introduce — several of them are the exact
 * "simplifications" that would silently restore unsafe behaviour, including the
 * three an adversarial review actually found in the first cut of this feature:
 *
 *   x    — fingerprint reduced back to the bare alert id (BLOCKER 1);
 *   xi   — suppression keyed on the recorded ACTIVE SET instead of the one
 *          alert that was actually spoken (BLOCKER 2);
 *   xii  — the return-to-green reset removed (BLOCKER 3a);
 *   xiii — the escalation carve-out removed (BLOCKER 3b).
 *
 * A green suite proves nothing about a check nothing exercises; this proves the
 * checks are load-bearing.
 *
 *   node scripts/mutate-red-replay.mjs
 *
 * A mutant is KILLED if the suite fails while it is applied. Survivors are
 * re-run against the FULL suite before being reported, so "survived" never means
 * "the fast subset happened to miss it".
 *
 * ★ The harness MUTATES THE WORKING TREE in place and restores each file in a
 *   finally block. Do not run git add/commit/checkout while it is running.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = resolve(REPO, 'server');
const GATE = resolve(SERVER, 'src/redReplayGate.ts');
const BROADCAST = resolve(SERVER, 'src/broadcast.ts');
const ALERTS = resolve(SERVER, 'src/alerts.ts');

/** Fast subset: the files that can observe these mutants. */
const SUBSET = ['test/redReplayGate.test.ts', 'test/broadcast.test.ts'];

const MUTANTS = [
  {
    id: 'i. active-set check dropped (nothing new can defeat suppression)',
    file: GATE,
    find: '  if (!i.activeFingerprints.every((f) => known.has(f))) return false;',
    to: '  void known; /* MUTANT */',
    why: 'A second, never-voiced critical appearing would no longer force an announce.',
  },
  {
    id: 'ii. timer comparison inverted',
    file: GATE,
    find: '  return elapsed < i.minGapMs;',
    to: '  return elapsed >= i.minGapMs;',
    why: 'Suppresses OLD reds and announces fresh ones — the gate backwards.',
  },
  {
    id: 'iii. fail CLOSED on missing/corrupt state',
    file: GATE,
    find: '  if (i.persisted == null) return false;',
    to: '  if (i.persisted == null) return true;',
    why: 'No evidence would mute the alarm — the failure direction that kills people.',
  },
  {
    id: 'iv. persists nothing (in-memory only)',
    file: GATE,
    find: "    atomicWriteFileSync(path, s == null ? '{}' : JSON.stringify(s));",
    to: '    void path; void s; /* MUTANT */',
    why: 'State would not survive the restart it exists to survive.',
  },
  {
    id: 'v. gate applied OUTSIDE the warm-up window',
    file: GATE,
    find: '  if (i.msSinceBoot >= i.windowMs) return false;',
    to: '  void i.windowMs; /* MUTANT */',
    why: 'A live mid-run critical would be rate-limited like a restart replay.',
  },
  {
    id: 'vi. records a PARTIAL/failed dispatch as announced',
    file: GATE,
    find: "  return level === 'red' && dispatchOk;",
    to: "  return level === 'red';",
    why: 'A broadcast nobody heard would buy 30 minutes of silence.',
  },
  {
    id: 'vii. empty active set no longer fails open',
    file: GATE,
    find: '  if (i.activeFingerprints.length === 0) return false;',
    to: '  void i.activeFingerprints; /* MUTANT */',
    why: 'An empty set makes the subset test vacuously true → suppress on no evidence.',
  },
  {
    id: 'viii. clock-skew (future timestamp) guard dropped',
    file: GATE,
    find: '  if (elapsed < 0) return false;',
    to: '  void elapsed; /* MUTANT */',
    why: 'A pre-NTP backward clock step would suppress indefinitely.',
  },
  {
    id: 'ix. identity taken from RAW alerts, not the counted pool',
    file: BROADCAST,
    find: '  const criticalFingerprints = criticals.map((a) => alertFingerprint(a)).sort();',
    to: "  const criticalFingerprints = alerts.filter((a) => a.severity === 'critical').map((a) => alertFingerprint(a)).sort();",
    why: 'Ids that never raise the condition would count as "already announced".',
  },

  /* ── the three blockers an adversarial review found in the first cut ───── */

  {
    id: 'x. ★ BLOCKER 1: fingerprint reduced back to the BARE ID',
    file: GATE,
    find: "  return `${a.id}${FP_SEP}${a.title}${FP_SEP}${a.fault ?? ''}`;",
    to: '  return `${a.id}${FP_SEP}${FP_SEP}`; /* MUTANT — id only */',
    why: 'dpu-err ids span EVERY error code: a different real fault on the same device would be muted.',
  },
  {
    id: 'x-b. ★ BLOCKER 1: the fault CODE dropped from the fingerprint (title kept)',
    file: GATE,
    find: "  return `${a.id}${FP_SEP}${a.title}${FP_SEP}${a.fault ?? ''}`;",
    to: '  return `${a.id}${FP_SEP}${a.title}${FP_SEP}`; /* MUTANT */',
    why: 'shp2-src-err has a CONSTANT title — without the code, every code collides.',
  },
  {
    id: 'x-c. ★ BLOCKER 1: alerts.ts stops threading the dpu-err code out',
    file: ALERTS,
    find: '          fault: `err${code}`,',
    to: '          /* MUTANT — fault dropped */',
    why: 'The fingerprint would be blind to a code change on the standing Core-3 fault.',
  },
  {
    id: 'x-e. ★ BLOCKER 1: alerts.ts stops threading the shp2-src-err code out',
    file: ALERTS,
    find: "title: 'Energy source error', fault: `err${n}`,",
    to: "title: 'Energy source error',",
    why: 'That title is a CONSTANT — without the code, every slot error code collides into one identity.',
  },
  {
    id: 'x-d. ★ BLOCKER 1: the fingerprint folds in a DRIFTING field (detail)',
    file: GATE,
    find: "export function alertFingerprint(a: { id: string; title: string; fault?: string }): string {",
    to: "export function alertFingerprint(a: { id: string; title: string; fault?: string; detail?: string }): string {\n  return `${a.id}${FP_SEP}${a.title}${FP_SEP}${a.detail ?? ''}`; /* MUTANT */\n  // eslint-disable-next-line no-unreachable",
    why: 'THE no-op trap: a live mV/percent in detail makes every tick a new fault, so nothing is ever suppressed.',
  },
  {
    id: 'xi. ★ BLOCKER 2: suppression keyed on the RECORDED ACTIVE SET, not the spoken alert',
    file: GATE,
    find: '  if (i.voicedFingerprint !== i.persisted.voicedFingerprint) return false;',
    to: '  if (!i.persisted.activeFingerprints.includes(i.voicedFingerprint)) return false;',
    why: 'The original subset rule: a critical that was counted but NEVER SPOKEN would count as announced.',
  },
  {
    id: 'xi-b. ★ BLOCKER 2: the voiced identity taken from the first active critical',
    file: GATE,
    find: '  const primary = pickPrimaryAlert(alerts, \'red\');',
    to: "  const primary = alerts.find((a) => a.severity === 'critical') ?? null; /* MUTANT */",
    why: 'Diverges from what buildAlertMessage actually says aloud — the gate would compare a fault nobody heard.',
  },
  {
    id: 'xii. ★ BLOCKER 3a: the return-to-green RESET removed',
    file: GATE,
    find: '      persisted = null;\n      saveState(path, null);',
    to: '      /* MUTANT — green no longer clears the evidence */',
    why: 'A critical that cleared (all-clear spoken) and re-raised inside 30 min would be muted.',
  },
  {
    id: 'xii-b. ★ BLOCKER 3a: green clears memory but NOT disk',
    file: GATE,
    find: '      persisted = null;\n      saveState(path, null);',
    to: '      persisted = null; /* MUTANT — disk not cleared */',
    why: 'The reset would not survive the restart it exists to survive.',
  },
  {
    id: 'xii-c. ★ BLOCKER 3a: the wrong level clears (yellow instead of green)',
    file: GATE,
    find: "  return level === 'green';",
    to: "  return level === 'yellow'; /* MUTANT */",
    why: 'An all-clear would leave stale evidence behind, and a yellow would destroy live evidence.',
  },
  {
    id: 'xiii. ★ BLOCKER 3b: the ESCALATION carve-out removed',
    file: GATE,
    find: "  if (isLevelEscalation(i.persisted.lastPlayedLevel, 'red')) return false;",
    to: '  void isLevelEscalation; /* MUTANT */',
    why: 'A red rising from a played yellow across a restart would be muted — the storm gate never does this.',
  },
  {
    id: 'xiii-b. ★ BLOCKER 3b: the shared rank ladder mangled (red no longer outranks yellow)',
    file: GATE,
    find: 'export const LEVEL_RANK: Record<BroadcastLevel, number> = { green: 0, yellow: 1, red: 2 };',
    to: 'export const LEVEL_RANK: Record<BroadcastLevel, number> = { green: 0, yellow: 1, red: 1 }; /* MUTANT */',
    why: 'Both this gate and the broadcast storm gate read this table — a drift here mutes escalations in two places.',
  },
  {
    id: 'xiii-c. ★ BLOCKER 3b: a yellow no longer demotes the recorded played level',
    file: GATE,
    find: '      persisted = { ...persisted, lastPlayedLevel: level };\n      saveState(path, persisted);',
    to: '      /* MUTANT — demotion dropped */',
    why: 'The escalation carve-out would never see the yellow that makes the next red a rise.',
  },
  {
    id: 'xiv. miswired-gate guard dropped (voiced id accepted as a fingerprint)',
    file: GATE,
    find: '  if (!isFingerprint(i.voicedFingerprint)) return false;',
    to: '  void isFingerprint; /* MUTANT */',
    why: 'Removes the fail-safe that makes a miswired gate a NO-OP instead of a mute.',
  },
  {
    id: 'xiv-b. miswired-gate guard dropped (active-list ids accepted)',
    file: GATE,
    find: '  if (!i.activeFingerprints.every(isFingerprint)) return false;',
    to: '  /* MUTANT */',
    why: 'Same fail-safe, other half: bare ids in the active list would be compared as identities.',
  },
];

function runTests(files) {
  try {
    execFileSync('node', ['--import', 'tsx', '--test', ...files], {
      cwd: SERVER, stdio: 'pipe', encoding: 'utf8',
    });
    return { pass: true };
  } catch (e) {
    const out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    const m = out.match(/^# fail (\d+)$/m) ?? out.match(/^ℹ fail (\d+)$/m);
    return { pass: false, failures: m ? Number(m[1]) : 'n/a' };
  }
}

console.log('baseline: running the subset unmutated...');
const baseline = runTests(SUBSET);
if (!baseline.pass) {
  console.error('ABORT — the baseline subset is not green. Fix that before mutating.');
  process.exit(2);
}
console.log('baseline OK\n');

const rows = [];
for (const m of MUTANTS) {
  const original = readFileSync(m.file, 'utf8');
  const hits = original.split(m.find).length - 1;
  if (hits !== 1) {
    rows.push({ id: m.id, verdict: 'NOT APPLIED', detail: `anchor matched ${hits}x (expected 1) — the harness has drifted from the source` });
    console.log(`✗ ${m.id}: ANCHOR MISS (${hits} matches)`);
    continue;
  }
  try {
    writeFileSync(m.file, original.replace(m.find, m.to));
    let r = runTests(SUBSET);
    let scope = 'subset';
    if (r.pass) { r = runTests(['test/**/*.test.ts']); scope = 'FULL suite'; }
    rows.push({
      id: m.id,
      verdict: r.pass ? 'SURVIVED' : 'KILLED',
      detail: r.pass ? `no test failed (${scope})` : `${r.failures} test(s) failed`,
      why: m.why,
    });
    console.log(`${r.pass ? '✗ SURVIVED' : '✓ KILLED  '}  ${m.id}  (${r.pass ? scope : `${r.failures} failures`})`);
  } finally {
    writeFileSync(m.file, original);
  }
}

const killed = rows.filter((r) => r.verdict === 'KILLED').length;
console.log(`\n| # | mutant | verdict | evidence |`);
console.log(`|---|--------|---------|----------|`);
for (const r of rows) console.log(`| ${r.id.split('.')[0]} | ${r.id.replace(/^[ivx]+(-[a-z])?\. /, '')} | ${r.verdict} | ${r.detail} |`);
console.log(`\n${killed}/${rows.length} mutants killed`);

// Restoration check — the tree must be exactly as we found it.
const post = runTests(SUBSET);
console.log(post.pass ? 'post-run: tree restored, subset green' : 'post-run: SUBSET FAILING — tree may not be restored!');
process.exit(killed === rows.length && post.pass ? 0 : 1);
