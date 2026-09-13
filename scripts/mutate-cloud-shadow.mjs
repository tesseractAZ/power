#!/usr/bin/env node
/**
 * mutate-cloud-shadow.mjs — committed mutation harness for v1.142.0's
 * cloud-shadow detector and the readback clock it shares.
 *
 * WHY COMMITTED: this defect produced NO error of any kind. On two consecutive
 * nights the SHP2's grid-presence alarm input held one value for 16.0 and 14.5
 * minutes while the 60 s REST poll returned 200 OK sixteen times in a row —
 * inside armed night-charge windows with 4-7 kW flowing. Zero fetch failures,
 * poll_health ok, /api/health blind:false. Nothing in this add-on was wrong;
 * EcoFlow's cloud served a replayed body, and every gate keys on the fetch
 * rather than the content. A guard against an invisible failure has to be proven
 * or it is just a comment.
 *
 *   node scripts/mutate-cloud-shadow.mjs
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
const SHADOW = resolve(SERVER, 'src/shp2Shadow.ts');
const GRID = resolve(SERVER, 'src/gridState.ts');
const MEMB = resolve(SERVER, 'src/shp2Membership.ts');
const SNAP = resolve(SERVER, 'src/snapshot.ts');

const SUBSET = ['test/shp2Shadow.test.ts', 'test/shp2ReadbackFreshness.test.ts', 'test/mqttFreshnessClock.test.ts', 'test/gridState.test.ts'];

const MUTANTS = [
  {
    id: 'i. ★★★ the witness collapses to the single grid scalar (the tempting fix)',
    file: SHADOW,
    find: "  return `${legs}|g=${p.gridWatt ?? 'x'}|b=${p.backupBatPercent ?? 'x'}|r=${p.backupRemainWh ?? 'x'}`;",
    to: "  return `g=${p.gridWatt ?? 'x'}`; /* MUTANT */",
    why: 'grid_power_home legitimately holds 0 W for 12.5+ h on a sunny day — this is a detector that could only ever fire falsely, exactly what the v1.139.0 doorbell deletion exists to prevent.',
  },
  {
    id: 'ii. the circuit vector is dropped from the witness',
    file: SHADOW,
    find: '    .map((c) => `${c.ch ?? \'?\'}:${c.watts ?? \'x\'}`)',
    to: "    .map(() => '') /* MUTANT */",
    why: 'The twelve legs are the entropy. Over 1,558 sampled minutes the full vector never held identical for one minute; the scalars alone do so routinely.',
  },
  {
    id: 'iii. ★ an unmeasurable poll accumulates toward stale instead of resetting',
    file: SHADOW,
    find: '  if (witness == null) return undefined;',
    to: '  if (witness == null) return prev; /* MUTANT */',
    why: 'A partial payload is not evidence of a shadow. A run of degraded responses would assert a freeze that never happened, and the alarm path would go unknown on real data.',
  },
  {
    id: 'iv. a missing circuit list yields a witness anyway',
    file: SHADOW,
    find: '  if (!Array.isArray(circuits) || circuits.length === 0) return null;',
    to: '  const circuits2 = Array.isArray(circuits) ? circuits : []; void circuits2; /* MUTANT */',
    why: 'Before the first full projection every payload would look identical, so a cold boot would declare a shadow and blind the alarm path at exactly the wrong moment.',
  },
  {
    id: 'v. staleness needs only the repeat count, not the duration',
    file: SHADOW,
    find: '  return f.repeats >= minRepeats && nowMs - f.firstSeenMs >= minMs;',
    to: '  return f.repeats >= minRepeats; /* MUTANT */',
    why: 'A burst of fast polls (a retry storm, a test harness) would assert a shadow in seconds.',
  },
  {
    id: 'vi. staleness needs only the duration, not the repeat count',
    file: SHADOW,
    find: '  return f.repeats >= minRepeats && nowMs - f.firstSeenMs >= minMs;',
    to: '  return nowMs - f.firstSeenMs >= minMs; /* MUTANT */',
    why: 'One long poll gap would assert a shadow off a single sample.',
  },
  {
    id: 'vii. the repeat clock restarts on every re-sighting',
    file: SHADOW,
    find: '  return { witness, firstSeenMs: prev.firstSeenMs, repeats: prev.repeats + 1 };',
    to: '  return { witness, firstSeenMs: nowMs, repeats: prev.repeats + 1 }; /* MUTANT */',
    why: 'The duration half of the test could then never be satisfied — the detector would be permanently inert.',
  },
  // ── the alarm path ─────────────────────────────────────────────────────────
  {
    id: 'viii. ★★★ a shadowed panel still contributes grid flow',
    file: GRID,
    find: '  if (!shp2 || !shp2.online || shp2.contentStaleSinceMs != null) return 0;',
    to: '  if (!shp2 || !shp2.online) return 0; /* MUTANT */',
    why: 'THE DEFECT: a frozen-high gridWatt keeps importLive=true → backstopping=true → silently MUTES a real at-floor outage beginning inside the window. v0.88.0 names this consequence in as many words.',
  },
  {
    id: 'ix. ★ a shadowed panel still asserts grid PRESENCE',
    file: GRID,
    find: '  if (!shp2 || !shp2.online || shp2.contentStaleSinceMs != null) return null;',
    to: '  if (!shp2 || !shp2.online) return null; /* MUTANT */',
    why: 'A stale "grid connected = 1" replayed by the cloud would assert presence into an outage.',
  },
  // ── the readback clock (F6) ────────────────────────────────────────────────
  {
    id: 'x. ★ the readback reverts to lastUpdated',
    file: MEMB,
    find: '  const lu = d.lastQuotaAtMs;',
    to: '  const lu = (d as { lastUpdated?: number }).lastUpdated; /* MUTANT */',
    why: 'setDeviceOnline bumps lastUpdated on a bare /status flip carrying no telemetry, so an OFFLINE→ONLINE flip would vouch for a projection nobody refreshed — and the freeze case is precisely one where no poll is coming.',
  },
  {
    id: 'xi. the readback ignores a replayed payload',
    file: MEMB,
    find: '  return d.contentStaleSinceMs == null;',
    to: '  return true; /* MUTANT */',
    why: 'A control readback would compare its target against a body the cloud is replaying, which is how revertVerified gets stamped for a revert no device confirmed.',
  },
  // ── the production bridge ──────────────────────────────────────────────────
  {
    id: 'xii. ★ the store stops tracking the witness',
    file: SNAP,
    find: '    cur.contentStaleSinceMs = latch ? latch.sinceMs : null;',
    to: '    cur.contentStaleSinceMs = null; /* MUTANT */',
    why: 'Every pure function stays correct and the detector never fires — the wire-it-to-the-production-bridge failure this project has shipped before.',
  },
  {
    id: 'xiii. ★ setDeviceOnline starts vouching for the projection again',
    file: SNAP,
    find: '    cur.lastUpdated = nowQ;\n    cur.lastQuotaAtMs = nowQ;',
    to: '    cur.lastUpdated = nowQ; /* MUTANT */',
    why: 'lastQuotaAtMs would never advance, so every readback reads stale and the actuator pauses forever — the opposite failure, and just as silent.',
  },
];

function run(files) {
  execFileSync('npm', ['test', '--silent', '--', ...files], { cwd: SERVER, stdio: 'pipe' });
}

const originals = new Map();
for (const m of MUTANTS) if (!originals.has(m.file)) originals.set(m.file, readFileSync(m.file, 'utf8'));

let killed = 0;
const survivors = [];
console.log(`mutate-cloud-shadow: ${MUTANTS.length} mutants\n`);

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
