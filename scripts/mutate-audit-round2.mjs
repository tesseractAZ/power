#!/usr/bin/env node
/**
 * mutate-audit-round2.mjs — committed mutation harness for v1.148.0.
 *
 * WHY COMMITTED: three of these guards were shipped BROKEN once already, and the
 * breakage was invisible each time.
 *
 * v1.142.0 taught the shadow's CONSUMERS to distrust a replayed payload and left
 * every GATE untouched — across two live firings `poll_health` stayed 'ok' and
 * /api/health returned blind:false while the diagnostic sensor read 240. The
 * latch was in-memory, so a fresh process published a 7,618 W grid reading its
 * predecessor had already declared a stale shadow. And the log-hygiene campaign
 * that claimed to buy forensic reach measured out at +52% volume and reach x0.65,
 * because LOG_LEVEL=debug is standing and the ring captures stdout at every
 * level: LEVEL IS NOT EMISSION.
 *
 *   node scripts/mutate-audit-round2.mjs
 *
 * ★ ANCHOR-ASSERTED; aborts rather than reporting green against an unmutated tree.
 * ★ A run is only evidence if the BASELINE was green — confirm `0 fail` first.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = resolve(REPO, 'server');
const SNAP = resolve(SERVER, 'src/snapshot.ts');
const ADV = resolve(SERVER, 'src/nightChargeAdvisor.ts');
const IDX = resolve(SERVER, 'src/index.ts');
const DISC = resolve(SERVER, 'src/mqttDiscovery.ts');

const SUBSET = ['test/auditRound2.test.ts', 'test/unreachableDetectors.test.ts', 'test/auditF7toF12.test.ts'];

const MUTANTS = [
  {
    id: 'i. ★★★ a REPLAYED payload stops moving the gate',
    file: SNAP,
    find: "  if (stale.length) return { ok: false, reason: 'shp2-content-frozen', sns: stale };",
    to: '  /* MUTANT */',
    why: 'THE DEFECT v1.142.0 left: the consumers distrust a shadow, every gate stays green, and poll_health has never left ok in its 30-day life.',
  },
  {
    id: 'ii. frozen outranks a FAILED fetch',
    file: SNAP,
    find: "  const bad = o.knownShp2Sns.filter((sn) => failed.has(sn));",
    to: "  const bad: string[] = []; /* MUTANT */",
    why: 'A fetch that actually failed would be reported as "content frozen" — the softer, vaguer of the two, on the harder evidence.',
  },
  {
    id: 'iii. ★ the live tick stops feeding the frozen set',
    file: SNAP,
    find: '        contentFrozenSns: Object.keys(devicesNow).filter(',
    to: '        contentFrozenSnsUnused: Object.keys(devicesNow).filter( /* MUTANT */',
    why: 'The verdict stays correct and the gate never fires — the wire-it-to-the-production-bridge failure, for the third release running.',
  },
  {
    id: 'iv. ★★★ the shadow witness stops being persisted',
    file: SNAP,
    find: '    if (this.contentFreshnessPath == null) this.loadContentFreshness(nowQ);',
    to: '    /* MUTANT */',
    why: 'Every process start disarms the fail-safe for ~4-5 min. Measured: a fresh boot published a 7,618 W grid reading its predecessor had already called a stale shadow.',
  },
  {
    id: 'v. ★★★ the rehydrated clock is CARRIED instead of re-stamped',
    file: SNAP,
    find: '          this.contentFreshness.set(sn, { witness: v.witness, firstSeenMs: nowMs, repeats: 1 });',
    to: '          this.contentFreshness.set(sn, { witness: v.witness, firstSeenMs: 0, repeats: 5 }); /* MUTANT */',
    why: 'The duration half of the AND would be satisfied by history, so one matching poll after any gap latches stale instantly — at the reserve floor that removes backstopping and can escalate a benign grid-up low-SoC to CRITICAL.',
  },
  {
    id: 'vi. the persisted file carries the clock too',
    file: SNAP,
    find: '      for (const [sn, f] of this.contentFreshness) out[sn] = { witness: f.witness };',
    to: '      for (const [sn, f] of this.contentFreshness) out[sn] = { witness: f.witness, ...f }; /* MUTANT */',
    why: 'Writing the clock invites a future reader to trust it on load, which is mutant v.',
  },
  {
    id: 'vii. ★★★ the per-poll success line comes back',
    file: SNAP,
    find: '  } else if (o.pollDebug && o.summaryDue) {',
    to: '  } else if (o.pollDebug) { /* MUTANT */',
    why: '1,058 lines in 16.4 h — 32.5% of ALL log bytes, 88.3% of INFO lines, and the single largest contributor to the +52% volume regression.',
  },
  {
    id: 'viii. ★ the summary absorbs the incident lines',
    file: SNAP,
    find: '  if (o.lastPollFailed) {\n    lines.push(`poll ok in ${o.tookMs}ms (recovered)`);',
    to: '  if (false) {\n    lines.push(`poll ok in ${o.tookMs}ms (recovered)`); /* MUTANT */',
    why: '`(recovered)` is the line an operator greps after a poll failure; the summary is a cadence stream and cannot replace a per-event signal.',
  },
  {
    id: 'ix. ★★★ the night-charge block goes back to naming nothing',
    file: ADV,
    find: '  const basisBlockedBy: string | null = basisComplete',
    to: '  const basisBlockedBy: string | null = true /* MUTANT */',
    why: 'A null plan left the pool at its 16% reserve floor for 9 h 13 m and the reason appeared in no log, plan, push or dashboard. Reconstructing it took an hour of live probing.',
  },
  {
    id: 'x. ★ the reason never reaches the spoken rationale',
    file: ADV,
    find: "    const why = inputs.basisBlockedBy ? ` (${inputs.basisBlockedBy})` : '';",
    to: "    const why = ''; /* MUTANT */",
    why: 'The 21:30 notification and the spoken advisory are where an operator actually meets the decision; naming it only in an API field is naming it nowhere.',
  },
  {
    id: 'xi. the coverage floor moves while being named',
    file: ADV,
    find: 'export const BASIS_MIN_BAND_COVERAGE = 0.78;',
    to: 'export const BASIS_MIN_BAND_COVERAGE = 0.60; /* MUTANT */',
    why: 'Naming a threshold must not move it: nightChargeGate accepts realized coverage in [0.78, 0.92] for WRITE readiness, so widening here silently moves the write gate too.',
  },
  {
    id: 'xii. the UNMEASURED line points back at the 404',
    file: IDX,
    find: 'see /api/night-charge/status → plan.buyDebiasBasis.`,',
    to: 'see /api/night-charge buyDebiasBasis.`, /* MUTANT */',
    why: 'A diagnostic that tells the operator to look somewhere that returns 404.',
  },
  {
    id: 'xiii. the broker reconnect knob goes back to 30 s',
    file: DISC,
    find: '  reconnectPeriod: 5_000,',
    to: '  reconnectPeriod: 30_000, /* MUTANT */',
    why: 'Measured: 30.03 s of unavailable entities against the broker own ~10 s recovery. auto_update is on, so it recurs on every Mosquitto release.',
  },
];

function run(files) {
  execFileSync('npm', ['test', '--silent', '--', ...files], { cwd: SERVER, stdio: 'pipe' });
}

const originals = new Map();
for (const m of MUTANTS) if (!originals.has(m.file)) originals.set(m.file, readFileSync(m.file, 'utf8'));

let killed = 0;
const survivors = [];
console.log(`mutate-audit-round2: ${MUTANTS.length} mutants\n`);

for (const m of MUTANTS) {
  const original = originals.get(m.file);
  const hits = original.split(m.find).length - 1;
  if (hits !== 1) {
    console.error(`\nABORT: anchor for "${m.id}" matched ${hits} times, expected exactly 1.`);
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
