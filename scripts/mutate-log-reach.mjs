#!/usr/bin/env node
/**
 * mutate-log-reach.mjs — committed mutation harness for v1.145.0's forensic-reach
 * and render-honesty fixes.
 *
 * WHY COMMITTED: two failure modes, both invisible.
 *
 * A log line that re-states unchanged state does not break anything — it just
 * costs hours of ring. The ring reaches ~53 h, and that is not hypothetical
 * here: an SHP2 question earlier in this project could not be settled because
 * the window had already rolled past it. The regression of "emit every tick
 * again" produces no error, only a shorter memory.
 *
 * And a screen that paints an unknown GREEN is making a claim the data does not
 * support, on the layer a human actually looks at. Reverting one of those is a
 * one-character edit and nothing fails.
 *
 *   node scripts/mutate-log-reach.mjs
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
const GEN = resolve(SERVER, 'src/telnet/plant/gen.ts');
const PV = resolve(SERVER, 'src/telnet/plant/pv.ts');
const BUS = resolve(SERVER, 'src/telnet/plant/bus.ts');
const MQTT = resolve(SERVER, 'src/ecoflow/mqtt.ts');

const SUBSET = ['test/logReachAndDisplayHonesty.test.ts', 'test/unreachableDetectors.test.ts'];

const MUTANTS = [
  // ── forensic reach ─────────────────────────────────────────────────────────
  {
    id: 'i. ★★★ the fleet-status dump goes back to every-tick INFO',
    file: SNAP,
    find: "  if (o.prevSignature == null || o.signature !== o.prevSignature) return 'info';",
    to: "  return 'info'; /* MUTANT */",
    why: '314 emissions carrying ONE distinct body in 53 h, over a fifth of the whole log — hours of ring spent saying nothing, on a system whose incident window is the ring.',
  },
  {
    id: 'ii. ★ a CHANGED fleet is silenced instead',
    file: SNAP,
    find: "  if (o.prevSignature == null || o.signature !== o.prevSignature) return 'info';",
    to: "  if (o.prevSignature == null) return 'info'; /* MUTANT */",
    why: 'A device changing state is the entire point of the dump; it would be buried at debug while the hourly anchor kept claiming all is well.',
  },
  {
    id: 'iii. the hourly liveness anchor is removed',
    file: SNAP,
    find: "  return o.nowMs - o.lastInfoMs >= (o.anchorMs ?? STATUS_ANCHOR_MS) ? 'info' : 'debug';",
    to: "  return 'debug'; /* MUTANT */",
    why: 'A steady fleet would go permanently silent at INFO, and "nothing changed" becomes indistinguishable from "the dump timer died".',
  },
  {
    id: 'iv. ★ the signature includes the per-tick counters',
    file: SNAP,
    find: "      const signature = parts.map((x) => x.replace(/ON\\/\\d+msg\\/(\\d+s|∞)/, 'ON')).join('|');",
    to: "      const signature = parts.join('|'); /* MUTANT */",
    why: 'The message counters move every tick, so EVERY dump becomes a change and the fix silently reverts to every-tick INFO while still looking correct.',
  },
  {
    id: 'v. the standing-failure heartbeat returns to hourly',
    file: SNAP,
    find: 'export const PERSISTING_FAILURE_HEARTBEAT_MS = 24 * 60 * 60_000;',
    to: 'export const PERSISTING_FAILURE_HEARTBEAT_MS = 60 * 60_000; /* MUTANT */',
    why: '48 lines in 53 h about a permanent, owner-settled product-class limit.',
  },
  // ── the absent-device breadcrumb ───────────────────────────────────────────
  {
    id: 'vi. ★ a device vanishing from /device/list goes unlogged again',
    file: SNAP,
    find: '      this.absentFromList.add(sn);',
    to: '      /* MUTANT */',
    why: 'It keeps its last `online` value forever, so "says online but has been gone for hours" is indistinguishable from a healthy device.',
  },
  {
    id: 'vii. ★★★ the breadcrumb escalates to marking the device OFFLINE',
    file: SNAP,
    find: "      this.logger(`device-list: ${d.deviceName} (${sn}) ABSENT from /device/list (last known ${d.online ? 'online' : 'offline'}) — state is now frozen, not refreshed`);",
    to: "      d.online = false; /* MUTANT */",
    why: 'That inverts a cloud-side list glitch into a device alarm — the wrong direction on a life-safety system, and the reason this is a breadcrumb rather than a state change.',
  },
  {
    id: 'viii. the breadcrumb repeats on every poll',
    file: SNAP,
    find: '      if (this.absentFromList.has(sn)) continue;',
    to: '      /* MUTANT */',
    why: 'One line per minute per missing device, forever — re-creating the very noise problem this release is about.',
  },
  // ── absence on the render surface ──────────────────────────────────────────
  {
    id: 'ix. ★★★ a pack that reported NOTHING renders NORMAL again',
    file: GEN,
    find: '    const reported = pk.temp != null || pk.minCellTemp != null || pk.soc != null;',
    to: '    const reported = true; /* MUTANT */',
    why: 'Every fault term is `x != null && <test>`, so an all-null pack scores false on all three and comes out GREEN on the screen a human reads.',
  },
  {
    id: 'x. ★★★ an ABSENT MPPT error code is a confirmed zero again',
    file: PV,
    find: "  if (code == null) return c.grey('—');",
    to: '  /* MUTANT */',
    why: 'An MPPT that stopped reporting its error register renders exactly like one reporting no fault.',
  },
  {
    id: 'xi. ★ the BUS screen stops showing staleness',
    file: BUS,
    find: '${qualTag}`, W));',
    to: '`, W)); /* MUTANT */',
    why: 'It becomes the only Plant screen with no staleness indication, while its liveness tick uses snap.generatedAt — which advances whether or not the SHP2 answered.',
  },
  {
    id: 'xii. the MQTT resubscribe dependency goes back to implicit',
    file: MQTT,
    find: '    resubscribe: true,',
    to: '    /* MUTANT */',
    why: 'The app’s own re-subscribe loop is dead on reconnect, so a library default flip would leave a silently one-way connection on the alarm path with the connect log still reading healthy.',
  },
];

function run(files) {
  execFileSync('npm', ['test', '--silent', '--', ...files], { cwd: SERVER, stdio: 'pipe' });
}

const originals = new Map();
for (const m of MUTANTS) if (!originals.has(m.file)) originals.set(m.file, readFileSync(m.file, 'utf8'));

let killed = 0;
const survivors = [];
console.log(`mutate-log-reach: ${MUTANTS.length} mutants\n`);

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
