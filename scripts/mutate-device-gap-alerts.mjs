#!/usr/bin/env node
/**
 * mutate-device-gap-alerts.mjs — committed mutation harness for v1.155.0: per-device
 * telemetry gaps rendered and counted as fleet outages.
 *
 * The recorder's gap ledger holds FLEET gaps (no `sn`: nothing wrote) and, since
 * v1.150.0, PER-DEVICE gaps (`sn` set: one device silent while the others kept
 * writing). No consumer read `sn`. `outageAlerts` announced a dark Core as "No
 * home-device samples reached the recorder … an MQTT/broker stall; writes have since
 * resumed" — false on every clause — `outageTracking` added its hours of silence to the
 * fleet outage minutes and flipped `system_outage_active_24h`, and `/api/telemetry-gaps`
 * reported it as the longest blackout.
 *
 * Each mutant below restores one part of that, or breaks one of the guards that keep
 * the two kinds apart (unique ids, the shared event lifecycle, the separate counts, the
 * production bridges).
 *
 *   node scripts/mutate-device-gap-alerts.mjs
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
const ALERTS = resolve(SERVER, 'src/alerts.ts');
const MONITOR = resolve(SERVER, 'src/alertMonitor.ts');
const DISCOVERY = resolve(SERVER, 'src/mqttDiscovery.ts');
const INDEX = resolve(SERVER, 'src/index.ts');

const SUBSET = [
  'test/deviceGapAlerts.test.ts',
  'test/outageAlerts.test.ts',
  'test/reviewFixesV114.test.ts',
  'test/mqttDiscovery.test.ts',
];

const MUTANTS = [
  // ── rendering ──────────────────────────────────────────────────────────────
  {
    id: 'i. ★★ a per-device gap falls through to the fleet text (the shipped defect)',
    file: ALERTS,
    find: '    if (g.sn) {\n      const alert = deviceGapAlert(',
    to: '    if (false /* MUTANT */ && g.sn) {\n      const alert = deviceGapAlert(',
    why: 'THE DEFECT: one dark Core is announced as "no home-device samples … an MQTT/broker stall; writes have since resumed".',
  },
  {
    id: 'ii. ★ the resolved name is ignored',
    file: ALERTS,
    find: "  const label = name != null && name.trim() !== '' ? name : sn;",
    to: '  const label = sn; /* MUTANT */',
    why: 'The operator is told a serial number when the store knows the device as "Core 2".',
  },
  {
    id: 'iii. a blank name is used as the label',
    file: ALERTS,
    find: "  const label = name != null && name.trim() !== '' ? name : sn;",
    to: '  const label = name != null ? name : sn; /* MUTANT */',
    why: 'An empty device name renders an alert that names nothing, with an empty push locator.',
  },
  {
    id: 'iv. ★ the alert is filed under System instead of the device',
    file: ALERTS,
    find: "    device: label,\n    priority: 'medium',\n    title: `Device telemetry gap",
    to: "    device: 'System', /* MUTANT */\n    priority: 'medium',\n    title: `Device telemetry gap",
    why: 'notifyLocator returns "" for System, so the push title names no device at all.',
  },
  {
    id: 'v. ★ the detail drops the fleet under-count consequence',
    file: ALERTS,
    find: ' Anything summed across the fleet in that window (production, load, forecast inputs) under-counts.',
    to: '',
    why: 'The operator is told a device was dark but not that every fleet sum over that window is short.',
  },
  // ── identity ───────────────────────────────────────────────────────────────
  {
    id: 'vi. ★★ the per-device id is the fleet id (collides with a fleet gap)',
    file: ALERTS,
    find: '  return tier === 0 ? `system-outage-device-${sn}-${startMs}` : `system-outage-device-${sn}-${startMs}-${tier}`;',
    to: '  return tier === 0 ? outageAlertId(startMs, durationMs) : outageAlertId(startMs, durationMs); /* MUTANT */',
    why: 'A device gap and the fleet gap starting on the same batch share one id; one alert silently stands in for the other.',
  },
  {
    id: 'vii. ★ the per-device id omits the SN',
    file: ALERTS,
    find: '  return tier === 0 ? `system-outage-device-${sn}-${startMs}` : `system-outage-device-${sn}-${startMs}-${tier}`;',
    to: '  return tier === 0 ? `system-outage-device-${startMs}` : `system-outage-device-${startMs}-${tier}`; /* MUTANT */',
    why: 'Two Cores whose last samples came in the same batch produce one alert between them.',
  },
  {
    id: 'viii. ★ the per-device id leaves the system-outage- event family',
    file: ALERTS,
    find: '  return tier === 0 ? `system-outage-device-${sn}-${startMs}` : `system-outage-device-${sn}-${startMs}-${tier}`;',
    to: '  return tier === 0 ? `device-gap-${sn}-${startMs}` : `device-gap-${sn}-${startMs}-${tier}`; /* MUTANT */',
    why: 'The event becomes a condition: a "Resolved:" push when it ages off, boot-seeded and never sent, and audible.',
  },
  {
    id: 'ix. mixed gaps are ordered by id string again',
    file: ALERTS,
    find: '  return out.sort((a, b) => (startOf.get(b.id) ?? 0) - (startOf.get(a.id) ?? 0) || b.id.localeCompare(a.id));',
    to: '  return out.sort((a, b) => b.id.localeCompare(a.id)); /* MUTANT */',
    why: 'Every system-outage-device- id sorts above every digit id, so a day-old device gap outranks a fresh power outage.',
  },
  // ── outage counters ────────────────────────────────────────────────────────
  {
    id: 'x. ★★ outageTracking counts per-device gaps as fleet outages again',
    file: ALERTS,
    find: '  const recent = gaps.filter((g) => !g.sn && Number.isFinite(g.endMs) && nowMs - g.endMs <= windowMs);',
    to: '  const recent = gaps.filter((g) => Number.isFinite(g.endMs) && nowMs - g.endMs <= windowMs); /* MUTANT */',
    why: 'One dark Core adds its whole silence to system_outage_total_minutes_24h and flips system_outage_active_24h.',
  },
  {
    id: 'xi. ★ the per-device count includes fleet gaps',
    file: ALERTS,
    find: '  return gaps.filter((g) => !!g.sn && Number.isFinite(g.endMs) && nowMs - g.endMs <= windowMs).length;',
    to: '  return gaps.filter((g) => Number.isFinite(g.endMs) && nowMs - g.endMs <= windowMs).length; /* MUTANT */',
    why: 'Every broker stall and restart reads as a device blackout, which is the same conflation in the other direction.',
  },
  {
    id: 'xii. the per-device count ignores its window',
    file: ALERTS,
    find: '  return gaps.filter((g) => !!g.sn && Number.isFinite(g.endMs) && nowMs - g.endMs <= windowMs).length;',
    to: '  return gaps.filter((g) => !!g.sn).length; /* MUTANT */',
    why: 'A "24h" sensor counts every per-device record the sidecar still holds.',
  },
  {
    id: 'xiii. ★ the per-device field is never populated',
    file: ALERTS,
    find: '    system_device_gap_count_24h: deviceGapCount(gaps, nowMs, 24 * 3_600_000),',
    to: '    system_device_gap_count_24h: 0, /* MUTANT */',
    why: 'The key exists, the sensor exists, and it reads 0 through a nine-day single-Core blackout.',
  },
  {
    id: 'xiv. the per-device sensor is not published',
    file: DISCOVERY,
    find: "  { unique_id: 'ecoflow_system_device_gap_count_24h',",
    to: "  // MUTANT { unique_id: 'ecoflow_system_device_gap_count_24h',",
    why: 'The count is computed and served, and HA has no entity to show it.',
  },
  // ── /api/telemetry-gaps rollups ────────────────────────────────────────────
  {
    id: 'xv. ★★ longest_gap_min spans per-device records again',
    file: ALERTS,
    find: '    longest_gap_min: longestMin(fleet),',
    to: '    longest_gap_min: longestMin(gaps), /* MUTANT */',
    why: 'One multi-day single-Core record reads as a multi-day fleet blackout on /api/telemetry-gaps.',
  },
  {
    id: 'xvi. the ledger fleet partition includes per-device records',
    file: ALERTS,
    find: '  const fleet = gaps.filter((g) => !g.sn);',
    to: '  const fleet = gaps; /* MUTANT */',
    why: 'fleet_gap_count counts every dark Core as a fleet gap.',
  },
  {
    id: 'xvii. the ledger device partition includes fleet records',
    file: ALERTS,
    find: '  const device = gaps.filter((g) => !!g.sn);',
    to: '  const device = gaps; /* MUTANT */',
    why: 'device_gap_count and longest_device_gap_min absorb broker stalls and restarts.',
  },
  // ── lifecycle + the production bridges ────────────────────────────────────
  {
    id: 'xviii. ★ the evidence gate holds a per-device gap alert open while its device is dark',
    file: MONITOR,
    find: '  if (isDeviceGapAlertId(id)) return true;',
    to: '  /* MUTANT */',
    why: 'The id names the dark SN, so the falling edge is judged by the very silence the alert reports.',
  },
  {
    id: 'xix. ★★ the alert monitor stops passing device names',
    file: MONITOR,
    find: '      ...outageAlerts(recorder.telemetryGaps(), Date.now(), OUTAGE_ALERT_OPTS, (sn) => snap.devices[sn]?.deviceName),',
    to: '      ...outageAlerts(recorder.telemetryGaps(), Date.now(), OUTAGE_ALERT_OPTS), /* MUTANT */',
    why: 'Every pure function stays correct and the live alert names the device only by serial.',
  },
  {
    id: 'xx. ★ /api/telemetry-gaps re-derives its own mixed rollup',
    file: INDEX,
    find: '    ...telemetryGapLedgerSummary(gaps),',
    to: '    count: gaps.length, longest_gap_min: Math.round(gaps.reduce((m, g) => Math.max(m, g.durationMs), 0) / 60_000), /* MUTANT */',
    why: 'The pure summary is correct and the endpoint never uses it.',
  },
];

// `npm test -- <files>` APPENDS the files to the package's own test/**/*.test.ts glob,
// so it runs the whole suite. The subset is run directly; the full suite only for a
// mutant the subset did not kill.
function runSubset() {
  execFileSync('node', ['--import', 'tsx', '--test', ...SUBSET], { cwd: SERVER, stdio: 'pipe' });
}
function runAll() {
  execFileSync('npm', ['test', '--silent'], { cwd: SERVER, stdio: 'pipe' });
}

const originals = new Map();
for (const m of MUTANTS) if (!originals.has(m.file)) originals.set(m.file, readFileSync(m.file, 'utf8'));

// Pre-flight every anchor before any test runs: anchor rot costs a second, not a run.
for (const m of MUTANTS) {
  const hits = originals.get(m.file).split(m.find).length - 1;
  if (hits !== 1) {
    console.error(`\nABORT: anchor for "${m.id}" matched ${hits} times, expected exactly 1.`);
    console.error('The source moved. Fix the anchor — do NOT report this run as green.');
    process.exit(2);
  }
}

// A red baseline kills every mutant for free.
try { runSubset(); } catch {
  console.error('\nABORT: the subset fails on the UNMUTATED tree. Fix the baseline first.');
  process.exit(2);
}

let killed = 0;
const survivors = [];
console.log(`mutate-device-gap-alerts: ${MUTANTS.length} mutants against ${SUBSET.join(' + ')}\n`);

for (const m of MUTANTS) {
  const original = originals.get(m.file);
  try {
    writeFileSync(m.file, original.replace(m.find, m.to));
    let died = false;
    try { runSubset(); } catch { died = true; }
    if (!died) { try { runAll(); } catch { died = true; } }
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
