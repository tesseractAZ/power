#!/usr/bin/env node
/**
 * mutate-pool-membership.mjs — committed harness for the v1.92.0 home-pool
 * membership resolver (server/src/shp2Membership.ts: isHomePoolDpu +
 * homeFleetMeanSoc).
 *
 * v1.129.0 — ANCHORS REPOINTED. Mutants i-iii targeted the single-line ternary
 * `return connected.size > 0 ? connected.has(sn) : !SPARE_DPU_SNS.has(sn);`.
 * v1.117.0 split that into three lines to insert the last-known-roster tier, and
 * every one of those anchors silently stopped matching. The harness has ABORTED
 * on its first mutant ever since — it was not passing, it was not running, and
 * an aborted harness reads exactly like a clean one unless you read the output.
 * The guarantee it exists to hold (the 2026-08-20 roster defect) was uncovered
 * that whole time.
 *
 * WHY COMMITTED: homeFleetMeanSoc is the SoC ladder's ONLY low-pool channel
 * during an SHP2-blind window — when `backupBatPercent` is null, every other
 * reserve producer is null-gated too. On 2026-08-20 a physical reconfiguration
 * inverted the static SPARE_DPU_SNS literal (Core 5 took a panel slot, Core 3
 * went to the bench). The allowlist-only filter then averaged the BENCH unit and
 * dropped a live pool member; because a bench unit charges independently, the
 * reported mean acquired a hard floor of benchSoc/3 — measured at 21.0% with the
 * bench at 63%, which made every critical rung (15/10/8/4/2%) unreachable.
 *
 * Each guard below must be demonstrably load-bearing, not decorative:
 *   - the roster must actually be consulted (not the literal)
 *   - the empty-roster fallback must survive (a cloud-dark panel must not
 *     silently empty the pool)
 *   - the online filter must survive (a stale SoC must not enter the mean)
 *
 *   node scripts/mutate-pool-membership.mjs
 *
 * ★ Anchor-asserted; restores in finally; do not touch the tree while running.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = resolve(REPO, 'server');
const MOD = resolve(SERVER, 'src/shp2Membership.ts');
const SUBSET = ['test/reserveBlindFailover.test.ts'];

const MUTANTS = [
  {
    id: 'i. ★ roster ignored — back to the static literal (the 08-20 defect verbatim)',
    find: '  if (connected.size > 0) return connected.has(sn);',
    to: '  /* MUTANT */',
    why: 'This IS the shipped bug: a benched Core is averaged in and a wired ex-spare is dropped.',
  },
  {
    id: 'ii. ★ empty-roster fallback removed (a cloud-dark panel empties the pool)',
    find: '  if (connected.size > 0) return connected.has(sn);',
    to: '  return connected.has(sn); /* MUTANT */',
    why: 'When the SHP2 itself goes dark the roster is empty, so every Core would be excluded and the fallback would return null exactly when it is needed.',
  },
  {
    id: 'iii. roster inverted (pool membership exactly backwards)',
    find: '  if (connected.size > 0) return connected.has(sn);',
    to: '  if (connected.size > 0) return !connected.has(sn); /* MUTANT */',
    why: 'The mean would be taken over precisely the DPUs that are NOT wired to the panel.',
  },
  {
    id: 'iv. ★ membership filter dropped from the mean entirely',
    find: '    if (!isHomePoolDpu(d.sn, roster, lastKnownRoster)) continue; // only DPUs actually wired into the backup pool',
    to: '    /* MUTANT */',
    why: 'Every DPU on the bench would be averaged into the life-safety reserve figure.',
  },
  {
    id: 'v. online filter dropped (a stale SoC enters the mean)',
    find: '    if (!d.online) continue;               // only Cores currently reporting fresh telemetry',
    to: '    /* MUTANT */',
    why: "A Core that went dark hours ago would contribute its last-known SoC, masking a real drawdown.",
  },
  {
    id: 'vi. null-guard removed (fabricates a number when nothing is reporting)',
    find: '  if (socs.length === 0) return null;',
    to: '  if (false) return null; /* MUTANT */',
    why: 'Returns NaN instead of null; the ladder would act on a fabricated reading rather than fall through to the reserve-blind warning.',
  },
];

function run(files) { execFileSync('npm', ['test', '--silent', '--', ...files], { cwd: SERVER, stdio: 'pipe' }); }
const original = readFileSync(MOD, 'utf8');
let killed = 0; const survivors = [];
console.log(`mutate-pool-membership: ${MUTANTS.length} mutants against ${SUBSET.join(' + ')}\n`);
for (const m of MUTANTS) {
  const hits = original.split(m.find).length - 1;
  if (hits !== 1) {
    console.error(`\nABORT: anchor for "${m.id}" matched ${hits} times, expected exactly 1.`);
    writeFileSync(MOD, original); process.exit(2);
  }
  try {
    writeFileSync(MOD, original.replace(m.find, m.to));
    let died = false;
    try { run(SUBSET); } catch { died = true; }
    if (!died) { try { run([]); } catch { died = true; } }
    if (died) { killed++; console.log(`  KILLED   ${m.id}`); }
    else { survivors.push(m); console.log(`  SURVIVED ${m.id}\n           ↳ ${m.why}`); }
  } finally { writeFileSync(MOD, original); }
}
console.log(`\n${killed}/${MUTANTS.length} mutants killed`);
if (survivors.length) { for (const s of survivors) console.log(`  - ${s.id}`); process.exit(1); }
console.log('post-run: tree restored');
