#!/usr/bin/env node
/**
 * mutate-audit-f7-f12.mjs — committed mutation harness for v1.144.0.
 *
 * WHY COMMITTED: almost every guard in this release makes something OBSERVABLE
 * that was previously inferred — a recovery line, a saturation warning, a
 * calibration that admits it could not measure. The failure mode of an
 * observability fix is silent by definition: nothing breaks, the line just stops
 * appearing, and the next auditor is back to inferring. Two of the twelve audit
 * items were also deliberately NOT changed, and those decisions are pinned here
 * so they are not quietly reversed from the same log evidence that prompted them.
 *
 *   node scripts/mutate-audit-f7-f12.mjs
 *
 * ★ Every mutation is ANCHOR-ASSERTED: if `find` is not present exactly once the
 *   harness ABORTS rather than reporting a green run against an unmutated tree.
 * ★ A harness run is only evidence if the BASELINE was green — a red tree kills
 *   every mutant for free. Confirm `0 fail` before reading the result.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = resolve(REPO, 'server');
const SNAP = resolve(SERVER, 'src/snapshot.ts');
const IDX = resolve(SERVER, 'src/index.ts');
const MON = resolve(SERVER, 'src/alertMonitor.ts');
const ALERTS = resolve(SERVER, 'src/alerts.ts');
const MQTT = resolve(SERVER, 'src/ecoflow/mqtt.ts');
const HEAL = resolve(SERVER, 'src/sessionSelfHeal.ts');
const DBX = resolve(SERVER, 'src/dbExport.ts');

const SUBSET = ['test/auditF7toF12.test.ts', 'test/unreachableDetectors.test.ts'];

const MUTANTS = [
  // ── F9 ─────────────────────────────────────────────────────────────────────
  {
    id: 'i. ★ poll RECOVERY is re-gated on an empty failure set',
    file: SNAP,
    find: '  if (o.lastPollFailed) {\n    lines.push(`poll ok in ${o.tookMs}ms (recovered)`);',
    to: '  if (o.failedCount === 0 && o.lastPollFailed) {\n    lines.push(`poll ok in ${o.tookMs}ms (recovered)`); /* MUTANT */',
    why: 'Four accessories fail every poll by design, so the branch is dead and an operator grepping after "poll failed" finds no recovery line at all.',
  },
  {
    id: 'ii. the duration summary is re-gated on an empty failure set',
    file: SNAP,
    // v1.148.0 — repointed: the per-poll line became a periodic summary (it was
    // 32.5% of all log bytes). The property is identical — four accessories fail
    // every poll by design, so re-adding that guard makes the branch dead code.
    find: '  } else if (o.pollDebug && o.summaryDue) {',
    to: '  } else if (o.failedCount === 0 && o.pollDebug && o.summaryDue) { /* MUTANT */',
    why: 'There would be no way to obtain a poll-duration distribution below the slow threshold even with debug on.',
  },
  // ── F8 ─────────────────────────────────────────────────────────────────────
  {
    id: 'iii. ★★★ the heal exception reverts to the projection singleton',
    file: IDX,
    find: '    const alarmPathSns = new Set(alarmPathShp2Sns(devices));',
    to: '    const alarmPathSns = new Set([findShp2(devices)?.sn].filter(Boolean) as string[]); /* MUTANT */',
    why: 'A projection exists only after a SUCCESSFUL quota fetch, so a restart while the panel is dark disarms the ONLY route self-heal has to the SHP2 — replaying the window without it yields zero of six heals.',
  },
  // ── F10 ────────────────────────────────────────────────────────────────────
  {
    id: 'iv. ★ /api/health stops carrying the poll verdict',
    file: IDX,
    find: '    pollHealth: pollHealth(),',
    to: '    /* MUTANT */',
    why: 'During a panel-dark window shorter than the 5-min staleness threshold — the shape of every such window in the record — the endpoint a watchdog polls returns a clean bill of health.',
  },
  {
    id: 'v. /api/health stops carrying the shadow duration',
    file: IDX,
    find: '    shp2ContentFrozenMs: (() => {',
    to: '    shp2ContentFrozenMsUnused: (() => { /* MUTANT */',
    why: 'The cloud-shadow guard would be invisible to anything polling the health endpoint.',
  },
  // ── F11 ────────────────────────────────────────────────────────────────────
  {
    id: 'vi. ★ the plan reports a hardcoded basis instead of the learner’s',
    file: IDX,
    find: '    buyDebiasBasis: buyDebiasCal.basis,',
    to: "    buyDebiasBasis: 'measured' as const, /* MUTANT */",
    why: 'A factor of 1.000 would keep reading as "measured, no bias" when the learner selected zero eligible rows — the exact silence this release closes.',
  },
  {
    id: 'vii. the unmeasured-calibration line is removed',
    file: IDX,
    find: '  if (buyDebiasCal.basis !== \'measured\') {',
    to: '  if (false) { /* MUTANT */',
    why: 'The "calibrated ×N" line only fires on a measured result, so a learner that can never measure says nothing at all.',
  },
  // ── F12 ────────────────────────────────────────────────────────────────────
  {
    id: 'viii. the cleared-alert ledger stops announcing saturation',
    file: MON,
    find: '    const saturated = clearedLog.length >= CLEARED_LOG_MAX ? ` [AT CAP ${CLEARED_LOG_MAX} — older records are being dropped]` : \'\';',
    to: "    const saturated = ''; /* MUTANT */",
    why: 'It rehydrated at exactly 1500 on all ten boots — recognisable as saturation only if you already know the cap.',
  },
  {
    id: 'ix. the broker username is logged in full again',
    file: MQTT,
    find: '  log(`mqtt: connecting to ${url} as ${username.slice(0, 9)}… (client_id=${clientId})`);',
    to: '  log(`mqtt: connecting to ${url} as ${username} (client_id=${clientId})`); /* MUTANT */',
    why: 'The password is correctly never logged; this is the other half of the same credential, and add-on logs get pasted into vendor tickets.',
  },
  {
    id: 'x. ★ the reserve alert stops disclosing that WE raised the floor',
    file: ALERTS,
    find: "          title: arbitrageRaised && onGrid\n            ? 'Backup filling to arbitrage reserve'",
    to: "          title: false\n            ? 'Backup filling to arbitrage reserve' /* MUTANT */",
    why: 'It stays lit a measured median 7.4 h (longest 11.3 h) reading like a fault, during a fill the add-on itself commanded.',
  },
  {
    id: 'xi. the published-snapshot boot line is removed',
    file: IDX,
    find: '    `db-export: published snapshot is ${gb} GB, ${days < 1 ? \'<1\' : Math.round(days)}d old`',
    to: "    '' /* MUTANT */",
    why: '1.72 GB sat in /share for four days riding in every nightly HA backup with nothing outside the web UI ever mentioning it.',
  },
  // ── the deliberate NON-changes ─────────────────────────────────────────────
  {
    id: 'xii. ★ the F7 non-fix rationale is deleted from the source',
    file: HEAL,
    find: ' * v1.144.0 — F7 was investigated and DELIBERATELY NOT CHANGED. Recorded here so',
    to: ' * MUTANT',
    why: 'The next reader of a 133-minute starvation log lowers the quorum, and solo heals then draw on the budget SHARED with the alarm-critical exception — which reached 5 of 6 and carried every heal that fired.',
  },
  {
    id: 'xiii. a TTL sweep is added to the DB export',
    file: DBX,
    find: 'export function publishedSnapshotStatus(',
    to: 'export function unlinkSyncSweep() { /* MUTANT */ } export function publishedSnapshotStatus(',
    why: 'That snapshot is the only recorder history reaching past the ~52 h log ring and was used for a real investigation; deleting it on a timer trades forensic reach for disk that is not scarce.',
  },
];

function run(files) {
  execFileSync('npm', ['test', '--silent', '--', ...files], { cwd: SERVER, stdio: 'pipe' });
}

const originals = new Map();
for (const m of MUTANTS) if (!originals.has(m.file)) originals.set(m.file, readFileSync(m.file, 'utf8'));

let killed = 0;
const survivors = [];
console.log(`mutate-audit-f7-f12: ${MUTANTS.length} mutants\n`);

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
