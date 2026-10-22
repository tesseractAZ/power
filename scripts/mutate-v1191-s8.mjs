#!/usr/bin/env node
/**
 * mutate-v1191-s8.mjs — v1.191.0 S8 (lane D): devices and topology.
 *
 * What this guards: BENCH_SPARE_SNS replaces the SPARE_DPU_SNS literal (OWNER DECISION 1) at every
 * place the literal was read (CA5), never as a union; the roster override still applies on top; the
 * display aliases merge option over /data over image; a DPU the owner never named is numbered by its
 * panel slot and two of them are told apart (CA4); no text prints "Core null"; the warranty export's
 * default chassis (X1); the self-heal quorum bounded by the account (Z5); the analytics worker gets
 * the roster (CA17); and productKind keeps the inline tests' answers.
 *
 *   S8-union          the option is UNIONED with the literal (the wired literal Core stays muted while the panel is dark)
 *   S8-roster         the roster override is dropped from the spare floor
 *   S8-mute-only-a/b/c the option replaces the literal at the mute floor only: homeCoreCoverage / isHomePoolDpu /
 *                     housePoolFallbackCoverage still read the literal (killed by the CA5 cold-boot case)
 *   S8-option-inert   BENCH_SPARE_SNS is read but ignored
 *   S8-none           `none` is not understood (read as a serial)
 *   S8-dpu-only       a DPU-only home's spares still count toward the fleet totals
 *   S8-unset-guard    with the option unset and no roster, the literal's serials leave the fleet totals
 *   S8-site-flag      /api/site sends the bench-spare flag while the option is unset (the web's rule changes)
 *   S8-bind           config.ts never binds its option reader (both device options inert)
 *   S8-alias-order    the alias merge order is reversed (the image file wins over /data and the option)
 *   S8-alias-option   DEVICE_ALIASES is ignored
 *   S8-alias-error    an unreadable option is silently treated as no option (no repair item)
 *   S8-flag           the store never marks a fallback-named DPU
 *   S8-dedupe         two un-renamed DPUs keep one shared name
 *   S8-slot           coreNumber ignores the fallback flag (a fallback-named Core has no number again)
 *   S8-tail           the serial-tail disambiguator is read as a Core number
 *   S8-null           the "Core null" guard is dropped
 *   S8-chain          the Core-number chain loses its `core N` rule
 *   S8-kind-order     productKind tests the panel before the DPU (a name with both reads as a panel)
 *   S8-kind-eq        the panel test becomes an equality ("Smart Home Panel 2" stops being a panel)
 *   S8-warranty       the warranty export no longer falls back to the one latched chassis
 *   S8-quorum         the self-heal quorum ignores the account's device count
 *   S8-worker         the analytics worker ignores the forwarded roster
 *   S8-replay         a respawned worker is not sent the roster again
 *   S8-bridge         BENCH_SPARE_SNS is no longer exported by the run script (the inert option)
 *   S8-unknown-spare  a BENCH_SPARE_SNS serial on no device raises no repair item
 *   S8-idx-warranty   index.ts: the warranty export ignores the chassis warrantyChassis picked
 *   S8-idx-quorum     index.ts: the self-heal call no longer passes the account's device count
 *   S8-idx-roster     index.ts: noteLiveRoster stops forwarding the roster to the worker
 *   S8-idx-kind       index.ts: the reconnect watch stops classifying a projection-less device
 *
 *   cd server && TSX_DISABLE_CACHE=1 MUTATE_CONCURRENCY=4 node ../scripts/mutate-v1191-s8.mjs
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TOPO = resolve(REPO, 'server/src/topology.ts');
const MEMB = resolve(REPO, 'server/src/shp2Membership.ts');
const SNAP = resolve(REPO, 'server/src/snapshot.ts');
const SITE = resolve(REPO, 'server/src/site.ts');
const CONFIG = resolve(REPO, 'server/src/config.ts');
const HEAL = resolve(REPO, 'server/src/sessionSelfHeal.ts');
const WORKER = resolve(REPO, 'server/src/analyticsWorker.ts');
const CLIENT = resolve(REPO, 'server/src/analyticsClient.ts');
const REPAIR = resolve(REPO, 'server/src/repairIssues.ts');
const RUN = resolve(REPO, 'rootfs/etc/services.d/ecoflow-panel/run');
const IDX = resolve(REPO, 'server/src/index.ts');
const SUBSET = [
  'test/topology.test.ts',
  'test/benchSpare.test.ts',
  'test/deviceAliases.test.ts',
  'test/selfHealAccountQuorum.test.ts',
  'test/rosterAwareSpares.test.ts',
  'test/golden.test.ts',
  'test/optionsEnvBridge.test.ts',
  'test/deviceIndexWiring.test.ts',
  'test/selfHealIdleQuorum.test.ts',
];

const MUTANTS = [
  {
    id: 'S8-union. ★★★ the option is unioned with the literal',
    file: TOPO,
    find: '  return configuredBenchSpareSns() ?? literal;',
    to: '  { const c = configuredBenchSpareSns(); return c ? new Set([...literal, ...c]) : literal; } /* MUTANT */',
    why: 'The literal still names a wired home Core: with the panel cloud-dark its genuine offline alarm is muted as an expected spare (the hole OWNER DECISION 1 closes).',
  },
  {
    id: 'S8-roster. ★★★ the roster override is dropped from the spare floor',
    file: MEMB,
    find: '  if (roster && roster.has(sn)) return false;',
    to: '  /* MUTANT: roster override dropped */',
    why: 'A Core the panel last reported as a home source is muted as a spare again (v1.121.0 undone).',
  },
  {
    id: 'S8-mute-only-a. ★★ homeCoreCoverage still reads the literal',
    file: MEMB,
    find: "          .filter((d) => d.projection?.kind === 'dpu' && !benchSpareFloor().has(d.sn))",
    to: "          .filter((d) => d.projection?.kind === 'dpu' && !SPARE_DPU_SNS.has(d.sn)) /* MUTANT */",
    why: 'On a cold boot with no roster the at-floor guard counts a configured spare and drops the wired Core (CA5).',
  },
  {
    id: 'S8-mute-only-b. ★★ isHomePoolDpu still reads the literal',
    file: MEMB,
    find: '  return !benchSpareFloor().has(sn);',
    to: '  return !SPARE_DPU_SNS.has(sn); /* MUTANT */',
    why: 'The SoC fallback averages the configured bench unit into the pool (CA5).',
  },
  {
    id: 'S8-mute-only-c. ★★ housePoolFallbackCoverage still reads the literal',
    file: MEMB,
    find: "        : Object.values(devices).filter((d) => d.projection?.kind === 'dpu' && !benchSpareFloor().has(d.sn)).map((d) => d.sn);",
    to: "        : Object.values(devices).filter((d) => d.projection?.kind === 'dpu' && !SPARE_DPU_SNS.has(d.sn)).map((d) => d.sn); /* MUTANT */",
    why: 'The ladders\' boot-gate denominator disagrees with the fallback SoC it describes (CA5).',
  },
  {
    id: 'S8-option-inert. ★★★ BENCH_SPARE_SNS is ignored',
    file: TOPO,
    find: "  const raw = access?.option<string | null>('BENCH_SPARE_SNS') ?? null;",
    to: '  const raw = null as string | null; /* MUTANT */',
    why: 'The option is declared, translated, exported and parsed, and the floor stays the literal (the inert-option defect).',
  },
  {
    id: 'S8-none. ★ `none` is read as a serial',
    file: TOPO,
    find: "  if (t.toLowerCase() === 'none') return new Set();",
    to: '  /* MUTANT: none not understood */',
    why: 'A home with no spares cannot say so; `none` reads as an empty list only by accident of the filter.',
  },
  {
    id: 'S8-dpu-only. ★★ a DPU-only home\'s spares still count toward the fleet',
    file: MEMB,
    find: '  if (connected.size === 0) return !(configuredBenchSpareSns() != null && isBenchSpareSn(sn));',
    to: '  if (connected.size === 0) return true; /* MUTANT */',
    why: 'With no panel roster a configured bench unit\'s PV and battery flow are added to the house totals (plan 3.8 S2).',
  },
  {
    id: 'S8-unset-guard. ★★★ unset, the literal\'s serials leave the fleet totals with no roster',
    file: MEMB,
    find: '  if (connected.size === 0) return !(configuredBenchSpareSns() != null && isBenchSpareSn(sn));',
    to: '  if (connected.size === 0) return !isBenchSpareSn(sn); /* MUTANT */',
    why: 'The owner\'s install changes with its options unchanged: on a cold boot or a dark panel the literal\'s two serials (one a wired home Core) drop out of every fleet aggregate (plan 6.4).',
  },
  {
    id: 'S8-site-flag. ★★ /api/site sends the flag while the option is unset',
    file: SITE,
    find: 'export const benchSpareOptionSetInput = (): boolean => benchSpareOptionSet();', // site.ts's input since lane C's module
    to: 'export const benchSpareOptionSetInput = (): boolean => true; /* MUTANT */',
    why: 'Unset, the floor is the literal, which does not name the real bench unit: the Solar page would relabel this install (3.8 S3).',
  },
  {
    id: 'S8-bind. ★★★ config.ts never binds its option reader',
    file: CONFIG,
    find: 'bindTopologyOptions({ option, dataFile: (name) => config.dataFile(name) });',
    to: '/* MUTANT: not bound */',
    why: 'Both device options read as unset in every process: the floor is the literal and the aliases the image file, whatever is configured.',
  },
  {
    id: 'S8-alias-order. ★★ the alias merge order is reversed',
    file: TOPO,
    find: '      for (const [sn, name] of Object.entries(parseAliasMap(text))) { aliases[sn] = name; sourceBySn[sn] = source; }',
    to: '      for (const [sn, name] of Object.entries(parseAliasMap(text))) { if (!(sn in aliases)) { aliases[sn] = name; sourceBySn[sn] = source; } } /* MUTANT */',
    why: 'The image file\'s entry beats the owner\'s /data file and option: an alias cannot be moved off the image (OWNER DECISION 3\'s precondition).',
  },
  {
    id: 'S8-alias-option. ★★ DEVICE_ALIASES is ignored',
    file: TOPO,
    find: "  const raw = o.optionRaw !== undefined ? o.optionRaw : access?.option<string | null>('DEVICE_ALIASES') ?? null;",
    to: '  const raw = o.optionRaw !== undefined ? o.optionRaw : null; /* MUTANT */',
    why: 'The option shows in the form and changes nothing.',
  },
  {
    id: 'S8-alias-error. ★ an unreadable option is silently skipped',
    file: TOPO,
    find: "      if (source !== 'image') errors.push({ source, message: e instanceof SyntaxError ? 'not valid JSON' : (e as Error).message });",
    to: '      /* MUTANT: error swallowed */',
    why: 'A typo in the JSON leaves every alias unapplied with nothing to say why (fail closed means said so).',
  },
  {
    id: 'S8-flag. ★★ the store never marks a fallback-named DPU',
    file: SNAP,
    find: '        ...(deviceAliases[d.sn] == null && isFallbackName(d.deviceName, d.sn) && isDpuProduct(productName) ? { nameFallback: true } : {}),',
    to: '        /* MUTANT: nameFallback never set */',
    why: 'An un-renamed DPU has no Core number again: "Core null" cards, and its alerts lose their locator (CA4).',
  },
  {
    id: 'S8-dedupe. ★★ two un-renamed DPUs keep one shared name',
    file: TOPO,
    find: '    out.set(e.sn, e.fallback && (count.get(e.name) ?? 0) > 1 ? disambiguatedName(e.name, { sn: e.sn, slot: slotOf(e.sn) }) : e.name);',
    to: '    out.set(e.sn, e.name); /* MUTANT */',
    why: 'Every alert, card and log line names both units "DELTA Pro Ultra" (CA4).',
  },
  {
    id: 'S8-slot. ★★ coreNumber ignores the fallback flag',
    file: TOPO,
    find: '  if (d.nameFallback === true) return slotOfDpu(devices, d.sn);',
    to: '  /* MUTANT: flag ignored */',
    why: 'A fallback-named DPU is numbered from "DELTA Pro Ultra" (no number), or from a serial tail.',
  },
  {
    id: 'S8-tail. ★ the serial-tail disambiguator reads as a Core number',
    file: TOPO,
    find: "  const n = name.replace(SERIAL_TAIL_SUFFIX, '');",
    to: '  const n = name; /* MUTANT */',
    why: 'The analytics worker (which numbers by name) calls a unit "Core 26" from its serial\'s last digits.',
  },
  {
    id: 'S8-null. ★★★ the "Core null" guard is dropped',
    file: TOPO,
    find: '  return coreNum != null && Number.isFinite(coreNum) ? `${DPU_LABEL} ${coreNum}` : fallbackName;',
    to: '  return `${DPU_LABEL} ${coreNum}`; /* MUTANT */',
    why: 'Repair cards print "Pack wearing fast: Core null · Pack 2" again.',
  },
  {
    id: 'S8-chain. ★ the Core-number chain loses its `core N` rule',
    file: TOPO,
    find: '  const m = n.match(/core\\s*(\\d+)/i) ?? n.match(/(\\d+)/);',
    to: '  const m = n.match(/(\\d+)/); /* MUTANT */',
    why: 'A name with another number before "Core N" is numbered by that number (the three copies agreed on the chain).',
  },
  {
    id: 'S8-kind-order. ★ productKind tests the panel before the DPU',
    file: TOPO,
    find: "  if (isDpuProduct(productName)) return 'dpu';\n  if (isShp2Product(productName)) return 'shp2';",
    to: "  if (isShp2Product(productName)) return 'shp2';\n  if (isDpuProduct(productName)) return 'dpu'; /* MUTANT */",
    why: 'projectByProduct always tested the DPU first: a name with both would project as a panel.',
  },
  {
    id: 'S8-kind-eq. ★★ the panel test becomes an equality',
    file: TOPO,
    find: "  return (productName ?? '').toLowerCase().includes('smart home panel');",
    to: "  return (productName ?? '').toLowerCase() === 'smart home panel'; /* MUTANT */",
    why: 'The live product name is "Smart Home Panel 2": the only panel stops being one at nine sites at once.',
  },
  {
    id: 'S8-warranty. ★★ the warranty export no longer falls back to the one latched chassis',
    file: TOPO,
    find: "  if (latched.length === 1) return { sn: latched[0], via: 'latched' };",
    to: '  /* MUTANT: latched fallback dropped */',
    why: 'Off the reference home the bare /api/warranty-export the alerts used to point at answers 400 even with one defective pack latched.',
  },
  {
    id: 'S8-quorum. ★★ the self-heal quorum ignores the account',
    file: HEAL,
    find: '  return Math.min(minStarvedDevices, Math.floor(accountDevices));',
    to: '  return minStarvedDevices; /* MUTANT */',
    why: 'A one-device account never rebuilds its starved session (Z5).',
  },
  {
    id: 'S8-worker. ★★ the analytics worker ignores the forwarded roster',
    file: WORKER,
    find: "        setLastKnownHomeRoster(Array.isArray(msg.sns) ? new Set(msg.sns.filter((s: unknown): s is string => typeof s === 'string')) : null);",
    to: '        /* MUTANT: roster ignored */',
    why: 'The worker\'s spare answers read the floor alone while the main thread\'s apply the roster override (CA17).',
  },
  {
    id: 'S8-replay. ★ a respawned worker is not sent the roster again',
    file: CLIENT,
    find: "        if (lastHomeRoster) { try { worker.postMessage({ kind: 'homeRoster', sns: lastHomeRoster }); } catch { /* */ } }",
    to: '        /* MUTANT: no replay */',
    why: 'After a worker crash the roster is lost until it next changes (the v1.119.0 owner-floor lesson).',
  },
  {
    id: 'S8-bridge. ★★★ BENCH_SPARE_SNS is no longer exported by the run script',
    file: RUN,
    find: `if bashio::config.has_value 'BENCH_SPARE_SNS'; then export BENCH_SPARE_SNS="$(bashio::config 'BENCH_SPARE_SNS')"; fi`,
    to: '# MUTANT: export dropped',
    why: 'The add-on form takes the serials and the server never sees them.',
  },
  {
    id: 'S8-unknown-spare. ★ a BENCH_SPARE_SNS serial on no device raises no repair item',
    file: REPAIR,
    find: '    const unknown = [...spares].filter((sn) => ctx.devices[sn] == null).sort();',
    to: '    const unknown: string[] = []; /* MUTANT */',
    why: 'A mistyped serial marks nothing as a spare and nothing says so: the real bench unit alarms as a home Core.',
  },
  // ── the production wiring (index.ts) ───────────────────────────────────────
  {
    id: 'S8-idx-warranty. ★★ the warranty export ignores the chassis warrantyChassis picked',
    file: IDX,
    find: '  const chassis = pick.sn;',
    to: '  const chassis = sn; /* MUTANT */',
    why: 'X1 is tested and never called: off the reference home the bare export answers 404 for the legacy serial.',
  },
  {
    id: 'S8-idx-quorum. ★★ the self-heal call drops the account\'s device count',
    file: IDX,
    find: '      now, healQuorum.count, selfHealState, DEFAULT_SELF_HEAL_CONFIG, { alarmCriticalStarved, accountDevices: Object.keys(devices).length },',
    to: '      now, healQuorum.count, selfHealState, DEFAULT_SELF_HEAL_CONFIG, { alarmCriticalStarved }, /* MUTANT */',
    why: 'Z5 is tested and never reached: a one-device account still never heals.',
  },
  {
    id: 'S8-idx-roster. ★★ noteLiveRoster stops forwarding the roster to the worker',
    file: IDX,
    find: '  // v1.191.0 (S8, CA17) — and to the analytics worker, which has its own copy of the module.\n  analytics.pushHomeRoster?.([...lastKnownRoster]);',
    to: '  /* MUTANT: roster not forwarded */',
    why: 'The worker keeps the boot roster for the life of the process (CA17).',
  },
  {
    id: 'S8-idx-kind. ★ the reconnect watch stops classifying a projection-less device',
    file: IDX,
    find: '      : productKind(d.productName); // v1.191.0 (S8) — the same two tests, in the same order',
    to: "      : 'other'; /* MUTANT */",
    why: 'A Core cloud-dark since boot (no projection) is watched as an unknown device.',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs).
import { runMutantsParallel } from './lib/mutateParallel.mjs';
// fullSuite: false — the subset holds every test that guards these mutants; a kill must come from
// it, not from an unrelated full-suite failure under parallel load (a false kill).
await runMutantsParallel({ name: 'mutate-v1191-s8', mutants: MUTANTS, subset: SUBSET, root: REPO, typecheck: true, fullSuite: false });
