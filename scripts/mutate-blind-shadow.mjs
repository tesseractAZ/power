#!/usr/bin/env node
/**
 * mutate-blind-shadow.mjs — committed mutation harness for v1.154.0's two
 * alarm-path wording and latch fixes.
 *
 * 1. THE SHADOW LATCH RELEASED ON ONE MOVED PAYLOAD. On 2026-09-12 the SHP2 cloud
 *    shadow latched and released four times in 87 minutes (04:10–04:20, 04:24–04:30,
 *    05:17–05:28, 05:32–05:37). Each gap was exactly the 4-minute re-arm: one
 *    refreshed body, which the cloud then replayed. For those minutes the alarm path
 *    read the panel's grid reading as live.
 *
 * 2. "THE ALARM SYSTEM IS BLIND" WHILE THE CORES STREAMED. A replayed, failed or
 *    never-asked panel poll routes into the telemetry-blind CRITICAL, whose text
 *    said the add-on "has received no telemetry" and "cannot see battery state, grid
 *    presence or any device fault". It was false, it was spoken aloud, and its Cause
 *    fact read "unknown".
 *
 * Both are wording-or-timing changes on the alarm path, which is exactly where a
 * plausible refactor restores the old behaviour with every test name still reading
 * right. Each mutant below restores one part of it.
 *
 *   node scripts/mutate-blind-shadow.mjs
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
const SNAP = resolve(SERVER, 'src/snapshot.ts');
const BLIND = resolve(SERVER, 'src/telemetryBlind.ts');
const MONITOR = resolve(SERVER, 'src/alertMonitor.ts');
const MEMBERSHIP = resolve(SERVER, 'src/shp2Membership.ts');

const SUBSET = [
  'test/shp2Shadow.test.ts',
  'test/mqttFreshnessClock.test.ts',
  'test/blindPanelWording.test.ts',
  'test/telemetryBlind.test.ts',
];

const MUTANTS = [
  // ── the latch ──────────────────────────────────────────────────────────────
  {
    id: 'i. ★★ the latch releases on the first moved payload (the shipped flapping)',
    file: SHADOW,
    find: '  return moved.length >= minDistinct ? undefined : { ...prev, moved };',
    to: '  return undefined; /* MUTANT */',
    why: 'THE 09-12 DEFECT: one refreshed body releases the guard and the alarm path reads a replayed grid value as live until the latch re-arms 4 minutes later.',
  },
  {
    id: 'ii. ★ a repeated moved body counts as new movement',
    file: SHADOW,
    find: '  if (prev.moved.includes(fresh.witness)) return prev;',
    to: '  /* MUTANT */',
    why: 'A cloud alternating between two cached bodies reaches the release count from one of them seen twice.',
  },
  {
    id: 'iii. the frozen body itself counts as movement',
    file: SHADOW,
    find: '  if (fresh.witness === prev.frozenWitness) return prev.moved.length > 0 ? { ...prev, moved: [] } : prev;',
    to: '  /* MUTANT */',
    why: 'Replay A, one refresh B, replay A again — and the release count is met by the replay.',
  },
  {
    id: 'iv. a re-latch discards the original onset',
    file: SHADOW,
    find: '    return { sinceMs: prev?.sinceMs ?? fresh.firstSeenMs, frozenWitness: fresh.witness, moved: [] };',
    to: '    return { sinceMs: fresh.firstSeenMs, frozenWitness: fresh.witness, moved: [] }; /* MUTANT */',
    why: 'A shadow held continuously from 04:10 publishes a fresh onset at 04:20, understating how long the panel has been untrustworthy.',
  },
  {
    id: 'v. an unmeasurable poll holds the latch',
    file: SHADOW,
    find: '  if (!fresh) return undefined;',
    to: '  if (!fresh) return prev; /* MUTANT */',
    why: 'A run of partial payloads — no evidence of a shadow at all — would hold a standing critical indefinitely.',
  },
  {
    id: 'vi. ★★ the store publishes the raw staleness, not the latch',
    file: SNAP,
    find: '    cur.contentStaleSinceMs = latch ? latch.sinceMs : null;',
    to: '    cur.contentStaleSinceMs = stale ? (fresh?.firstSeenMs ?? nowQ) : null; /* MUTANT */',
    why: 'Every pure function stays correct and the production bridge ignores them — the flapping ships with a green latch suite.',
  },
  // ── the wording ────────────────────────────────────────────────────────────
  {
    id: 'vii. ★★ the panel wording is never used (the false "blind" text returns)',
    file: BLIND,
    find: '  const panel = v.failure != null && ctx != null && ctx.otherReportingCount > 0',
    to: '  const panel = false /* MUTANT */ && v.failure != null && ctx != null && ctx.otherReportingCount > 0',
    why: 'THE DEFECT: a stale panel is announced as "the alarm system is blind — no telemetry" while the Cores stream.',
  },
  {
    id: 'viii. ★ the panel wording is used with nothing else reporting',
    file: BLIND,
    find: '  const panel = v.failure != null && ctx != null && ctx.otherReportingCount > 0',
    to: '  const panel = v.failure != null && ctx != null && ctx.otherReportingCount >= 0 /* MUTANT */',
    why: 'The reverse lie: with every device dark the alert still uses the panel wording and says "0 other devices are still reporting".',
  },
  {
    id: 'ix. the panel wording is used for a failure that is not a panel verdict',
    file: BLIND,
    find: '  const panel = v.failure != null && ctx != null && ctx.otherReportingCount > 0',
    to: '  const panel = ctx != null && ctx.otherReportingCount > 0 /* MUTANT */',
    why: 'An auth or network outage, with devices still inside their freshness window, renders as a panel fault — or throws.',
  },
  {
    id: 'x. the Cause fact reverts to "unknown" for a panel verdict',
    file: BLIND,
    find: '        value: v.failure != null',
    to: '        value: false /* MUTANT */ && v.failure != null',
    why: 'The verdict naming the cause was computed and then discarded from the one fact meant to carry it.',
  },
  {
    id: 'xi. ★ a panel verdict survives a later thrown poll',
    file: BLIND,
    find: '  lastFailure = failure;',
    to: '  if (failure) lastFailure = failure; /* MUTANT */',
    why: 'A total outage following one stale-panel tick is described as one stale panel with others reporting.',
  },
  {
    id: 'xii. a healthy poll does not clear the panel verdict',
    file: BLIND,
    find: '  lastError = null;\n  lastFailure = null;',
    to: '  lastError = null; /* MUTANT */',
    why: 'The next unrelated failure inherits a panel verdict that stopped being true at the last good poll.',
  },
  {
    id: 'xiii. ★ the named panel counts as "another device reporting"',
    file: BLIND,
    find: '    if (!d || affected.has(sn)) continue;',
    to: '    if (!d) continue; /* MUTANT */',
    why: 'A frozen panel whose replay keeps its own quota clock fresh vouches for itself, so the panel wording is used with nothing else alive.',
  },
  {
    id: 'xiv. a stale device counts as reporting',
    file: BLIND,
    find: '    if (at > 0 && nowMs - at < staleMs) otherReportingCount++;',
    to: '    if (at > 0) otherReportingCount++; /* MUTANT */',
    why: 'Every device ever seen counts, so the alert claims others are reporting during a total outage.',
  },
  {
    id: 'xv. a bare online/offline flip counts as telemetry',
    file: BLIND,
    find: '    const at = d.lastQuotaAtMs ?? d.lastUpdated ?? 0;',
    to: '    const at = d.lastUpdated ?? d.lastQuotaAtMs ?? 0; /* MUTANT */',
    why: 'lastUpdated is bumped by a status flip that carries no data (v1.142.0), so a silent device reads as reporting.',
  },
  {
    id: 'xvi. an offline device counts as reporting',
    file: BLIND,
    find: '    if (d.online === false) continue;',
    to: '    /* MUTANT */',
    why: 'A device the cloud reports offline is counted by its last quota for up to five minutes.',
  },
  {
    id: 'xvii. a device that is not an alarm source counts as reporting',
    file: BLIND,
    find: "    if (kind !== 'dpu' && kind !== 'shp2') continue;",
    to: '    /* MUTANT */',
    why: 'A generic small device streaming normally is taken as evidence the alarm path can still see.',
  },
  // ── the production bridges ─────────────────────────────────────────────────
  {
    id: 'xviii. ★★ the poll loop stops passing its verdict',
    file: SNAP,
    find: '          { cause: health.reason, sns: health.sns },',
    to: '          /* MUTANT */',
    why: 'Every function above stays correct and the live alert never learns the cause — the false text ships behind a green suite.',
  },
  {
    id: 'xix. ★★ the alert monitor renders without context',
    file: MONITOR,
    find: '        return telemetryBlindAlerts(verdict, blindNowMs, blindAlertContext(blindDevices, verdict.failure, blindNowMs, { isOutsideHomePool: (sn) => isOutsideHomePool(sn, blindDevices) }));',
    to: '        return telemetryBlindAlerts(verdict, blindNowMs); /* MUTANT */',
    why: 'Without the device map the panel wording is unreachable in production.',
  },
  // ── v1.154.0 review ────────────────────────────────────────────────────────
  {
    id: 'xx. ★ the frozen body reappearing does not restart the count',
    file: SHADOW,
    find: '  if (fresh.witness === prev.frozenWitness) return prev.moved.length > 0 ? { ...prev, moved: [] } : prev;',
    to: '  if (fresh.witness === prev.frozenWitness) return prev; /* MUTANT */',
    why: 'Refresh B, frozen A again, refresh C releases the guard while the cloud is demonstrably still replaying A.',
  },
  {
    id: 'xxi. ★ a second, shadowed panel counts as another device reporting',
    file: BLIND,
    find: '    if (d.contentStaleSinceMs != null) continue;',
    to: '    /* MUTANT */',
    why: 'A replayed body stamps its quota clock every poll, so a frozen panel vouches for sight the system already treats as UNKNOWN.',
  },
  {
    id: 'xxii. a Core outside the home pool counts as another device reporting',
    file: BLIND,
    find: "    if (kind === 'dpu' && opts.isOutsideHomePool?.(sn)) continue;",
    to: '    /* MUTANT */',
    why: 'Bench hardware on another circuit turns a dark home fleet into "1 other device is still reporting".',
  },
  {
    id: 'xxiii. the alert monitor stops passing the pool predicate',
    file: MONITOR,
    find: '        return telemetryBlindAlerts(verdict, blindNowMs, blindAlertContext(blindDevices, verdict.failure, blindNowMs, { isOutsideHomePool: (sn) => isOutsideHomePool(sn, blindDevices) }));',
    to: '        return telemetryBlindAlerts(verdict, blindNowMs, blindAlertContext(blindDevices, verdict.failure, blindNowMs)); /* MUTANT */',
    why: 'The exclusion is correct in the pure function and absent in production.',
  },
  {
    id: 'xxiv. ★ the pool predicate ignores the published roster (the stale literal decides)',
    file: MEMBERSHIP,
    find: '  return !isHomePoolDpu(sn, devices, rosterOf());',
    to: '  return !isHomePoolDpu(sn, devices); /* MUTANT */',
    why: 'With the panel dark the literal decides: the real bench Core 3 counts as sight of the house and wired Core 5 does not.',
  },
  {
    id: 'xxv. ★ twelve unreadable circuits form a witness',
    file: SHADOW,
    find: '  if (!circuits.some((c) => c.watts != null)) return null;',
    to: '  /* MUTANT */',
    why: 'A body without the per-circuit array latches on three low-entropy scalars, and with the reset a quiet panel can hold a spoken critical indefinitely.',
  },
];

function run(files) {
  execFileSync('npm', ['test', '--silent', '--', ...files], { cwd: SERVER, stdio: 'pipe' });
}

const originals = new Map();
for (const m of MUTANTS) if (!originals.has(m.file)) originals.set(m.file, readFileSync(m.file, 'utf8'));

let killed = 0;
const survivors = [];
console.log(`mutate-blind-shadow: ${MUTANTS.length} mutants against ${SUBSET.join(' + ')}\n`);

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
