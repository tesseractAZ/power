#!/usr/bin/env node
/**
 * mutate-bridge-capacity.mjs — committed harness for v1.207.0: the energy bridge's capacity source (stage 1).
 *
 * A dark slot is counted on min(ratio, 1) × the slot's nameplate, the ratio from a tracker the recorder keeps for the bridge
 * (poolEnergyBasis.ts coreRatios; recorder.ts bridgeCapacityTracker; energyBridge.ts slotCapacity / resolveCapacity):
 * measured, else the Core's own held ratio at any age, else the lowest known, else the nameplate only when no ratio was ever
 * measured. Until v1.207.0 the figure came from pack rows read at most 45 days back and then fell to the nameplate in silence.
 *
 * (R) THE RECORDER'S TRACKER: its seed, its own file, the seed persisted, no age limit, fed at every rollup, each slot its
 *     own Core's ratio.
 * (T) THE TRACKER (poolEnergyBasis.ts): coreRatios' per-Core answer, basis and instant; the caller's age limit; the live
 *     ratios recorded and saved; the seed written to the own file (persistSeed), for the bridge's tracker alone; a save
 *     that keeps every Core.
 * (B) THE BRIDGE (energyBridge.ts): the cap at the nameplate; no answer never the nameplate; no nameplate, no figure; the
 *     figure asked at every rollup, night included, and used by the daylight window; the line on every change of basis or
 *     figure, again at a second dark span, never a serial, never a throw; the debug block.
 *
 *   node scripts/mutate-bridge-capacity.mjs [--only <id prefix>]
 *
 * ★ Every id starts BC- (no other harness uses it). Anchor-asserted (each anchor matches exactly once); every mutant must
 *   TYPECHECK (one that does not is reported INVALID and fails the run); each mutant names the test files that must kill it,
 *   and only those run for it. The recorder's construction-line mutants name the behaviour tests only, never the source pin
 *   (runwayBasisContracts.test.ts), so each kill is a behaviour. Run with MUTATE_CONCURRENCY=4, on a GREEN tree.
 *   The companion re-cut: B-xxii in mutate-energy-core-outage.mjs (a known ratio is ignored: the nameplate instead).
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EB = resolve(REPO, 'server/src/energyBridge.ts');
const RC = resolve(REPO, 'server/src/recorder.ts');
const PEB = resolve(REPO, 'server/src/poolEnergyBasis.ts');

const T_PLANT = 'test/bridgeCapacityBasis.test.ts';
const T_EB = 'test/energyBridge.test.ts';
const T_PEB = 'test/poolEnergyBasis.test.ts';
const T_REC = 'test/recorderEnergyBridge.test.ts';

const TRACKER = "  const bridgeCapacityTracker = new PoolEnergyBasisTracker({ seedPath: defaultPoolEnergyBasisPath('pool-energy-basis'), path: defaultPoolEnergyBasisPath('pool-energy-basis-bridge'), persistSeed: true });";
const RESOLVED = "    resolved.set(c.sn, { ratio, basis: b, atMs: b === 'measured' ? nowMs : b === 'held' ? (held.get(c.sn)?.atMs ?? null) : null });";
const ASK = '    const next = slotCapacity(nameplate, nameplate != null && nameplate > 0 ? deps.coreRatio(s.panelSn, s.sn, devices, nowMs) : null, prev);';

const MUTANTS = [
  /* ── R: the recorder's tracker ── */
  {
    id: 'BC-R-i. ★★★ the bridge\'s tracker has no seed',
    file: RC, tests: [T_PLANT],
    find: TRACKER,
    to: "  const bridgeCapacityTracker = new PoolEnergyBasisTracker({ path: defaultPoolEnergyBasisPath('pool-energy-basis-bridge'), persistSeed: true }); /* MUTANT */",
    why: 'Cores dark since before the tracker existed are counted on the nameplate at once: the 11-29 step brought forward to the deploy.',
  },
  {
    id: 'BC-R-ii. ★★★ the bridge\'s tracker writes the runway tracker\'s file',
    file: RC, tests: [T_PLANT],
    find: TRACKER,
    to: "  const bridgeCapacityTracker = new PoolEnergyBasisTracker({ seedPath: defaultPoolEnergyBasisPath('pool-energy-basis'), path: defaultPoolEnergyBasisPath('pool-energy-basis'), persistSeed: true }); /* MUTANT */",
    why: 'Two threads write one file: the worker\'s panel figures and increase hold are overwritten from the main thread.',
  },
  {
    id: 'BC-R-iii. ★★★ the bridge\'s tracker has no file of its own',
    file: RC, tests: [T_PLANT],
    find: TRACKER,
    to: "  const bridgeCapacityTracker = new PoolEnergyBasisTracker({ seedPath: defaultPoolEnergyBasisPath('pool-energy-basis'), persistSeed: true }); /* MUTANT */",
    why: 'Every boot depends on the worker\'s file, and a ratio the bridge measured itself is lost at the next restart.',
  },
  {
    id: 'BC-R-iv. ★★★ the bridge\'s tracker does not persist its seed',
    file: RC, tests: [T_PLANT],
    find: TRACKER,
    to: "  const bridgeCapacityTracker = new PoolEnergyBasisTracker({ seedPath: defaultPoolEnergyBasisPath('pool-energy-basis'), path: defaultPoolEnergyBasisPath('pool-energy-basis-bridge'), persistSeed: false }); /* MUTANT */",
    why: 'While no Core returns, each boot reads the worker\'s file again: without it the slots are on the nameplate.',
  },
  {
    id: 'BC-R-v. ★★★ the pool figures\' 30-day expiry applies to the bridge',
    file: RC, tests: [T_PLANT],
    find: '      return panel ? bridgeCapacityTracker.coreRatios(devices, panel, nowMs, Number.POSITIVE_INFINITY) : null;',
    to: '      return panel ? bridgeCapacityTracker.coreRatios(devices, panel, nowMs) : null; /* MUTANT */',
    why: 'Slots 1 and 3 fall to the lowest known ratio (-2.3 % and -5.5 %): the figure moves at deploy and the check loosens on the thinnest slot.',
  },
  {
    id: 'BC-R-vi. ★★★ the tracker is fed only while a slot is dark',
    file: RC, tests: [T_PLANT],
    find: '    for (const p of allShp2s(snap.devices)) bridgeCoreRatios(snap.devices, p.sn, now);',
    to: '    /* MUTANT */',
    why: 'A Core is never measured while it reports, so its next outage starts on the nameplate (or on a ratio months old).',
  },
  {
    id: 'BC-R-vii. ★★★ every slot is counted on one Core\'s ratio',
    file: RC, tests: [T_PLANT],
    find: '      const r: BridgeCoreRatio | null = bridgeCoreRatios(devices, panelSn, nowMs)?.get(sn) ?? null;',
    to: '      const r: BridgeCoreRatio | null = [...(bridgeCoreRatios(devices, panelSn, nowMs)?.values() ?? [])][0] ?? null; /* MUTANT */ void sn;',
    why: 'Slots 2 and 3 are counted on slot 1\'s capacity: 2.3 % high and 3.3 % low.',
  },

  /* ── T: the tracker ── */
  {
    id: 'BC-T-i. ★★★ coreRatios ignores the caller\'s age limit',
    file: PEB, tests: [T_PEB, T_PLANT],
    find: 'this.cores, nowMs, maxHeldAgeMs);',
    to: 'this.cores, nowMs, Math.min(maxHeldAgeMs, this.maxHeldAgeMs)); /* MUTANT */',
    why: 'The bridge asks for a held ratio at any age and gets the pool figures\' 30 days.',
  },
  {
    id: 'BC-T-ii. ★★★ coreRatios does not record the live ratios',
    file: PEB, tests: [T_PEB, T_PLANT],
    find: '    if (this.recordLive(cand.live, nowMs)) this.save();\n    return cand.perCore ?? new Map();',
    to: '    return cand.perCore ?? new Map(); /* MUTANT */',
    why: 'A Core that reported an hour ago has no held ratio when it goes dark.',
  },
  {
    id: 'BC-T-iii. ★★★ coreRatios records the live ratios in memory only',
    file: PEB, tests: [T_PEB, T_PLANT],
    find: '    if (this.recordLive(cand.live, nowMs)) this.save();\n    return cand.perCore ?? new Map();',
    to: '    this.recordLive(cand.live, nowMs); /* MUTANT */\n    return cand.perCore ?? new Map();',
    why: 'A restart mid-outage forgets every ratio the bridge\'s tracker measured.',
  },
  {
    id: 'BC-T-iv. ★★ a fleet with no ratio reads min-known',
    file: PEB, tests: [T_PEB],
    find: RESOLVED,
    to: "    resolved.set(c.sn, { ratio, basis: c.basis, atMs: b === 'measured' ? nowMs : b === 'held' ? (held.get(c.sn)?.atMs ?? null) : null }); /* MUTANT */",
    why: 'The nameplate is logged as "the lowest ratio known for any Core": the one line that says no ratio exists is never printed.',
  },
  {
    id: 'BC-T-v. ★★ a held ratio is stamped with the evaluation instant',
    file: PEB, tests: [T_PEB, T_PLANT],
    find: RESOLVED,
    to: "    resolved.set(c.sn, { ratio, basis: b, atMs: b === 'measured' || b === 'held' ? nowMs : null }); /* MUTANT */",
    why: 'The log line dates a ratio measured in October to this rollup.',
  },
  {
    id: 'BC-T-vi. ★★★ the candidate scale answers no per-Core ratio',
    file: PEB, tests: [T_PEB, T_PLANT],
    find: '  return { scale: clampScale(num / den), basis, connected: perCore.length, live, perCore: resolved };',
    to: '  return { scale: clampScale(num / den), basis, connected: perCore.length, live }; /* MUTANT */',
    why: 'The tracker never answers: no slot has a capacity, so nothing is inferred and no field is checked.',
  },
  {
    id: 'BC-T-vii. ★★★ the seed is adopted but not written (persistSeed)',
    file: PEB, tests: [T_PEB, T_PLANT],
    find: '    if (this.persistSeed && own === 0 && this.cores.size > 0) this.save();',
    to: '    if (this.persistSeed && own === 0 && this.cores.size > 0) { /* MUTANT */ }',
    why: 'For as long as the Cores stay dark every boot depends on the worker\'s file.',
  },
  {
    id: 'BC-T-viii. ★★★ every tracker persists its seed',
    file: PEB, tests: [T_PEB],
    find: '    this.persistSeed = opts.persistSeed === true;',
    to: '    this.persistSeed = opts.persistSeed !== false; /* MUTANT */',
    why: 'The cushion tracker writes the worker\'s ratios to its own file: its v1.203.0 behaviour moved by a change scoped to the bridge.',
  },
  {
    id: 'BC-T-ix. ★★★ the save keeps only the Cores that reported live',
    file: PEB, tests: [T_PEB, T_PLANT],
    find: '    const out: PersistShape = { v: 1, cores: Object.fromEntries(this.cores), panels: Object.fromEntries(this.panels) };',
    to: '    const out: PersistShape = { v: 1, cores: Object.fromEntries([...this.cores].filter(([sn]) => this.persistedAtMs.has(sn))), panels: Object.fromEntries(this.panels) }; /* MUTANT */',
    why: 'When one Core returns, the file is written with that Core alone; it is never re-seeded, so after the next restart the two still-dark slots fall to the returned Core\'s ratio.',
  },

  /* ── B: the bridge ── */
  {
    id: 'BC-B-i. ★★ the ratio is not capped at the nameplate',
    file: EB, tests: [T_EB],
    find: '  const ratio = Math.min(1, r.ratio);',
    to: '  const ratio = r.ratio; /* MUTANT */',
    why: 'A pack list reading above its design counts the slot on more than the panel\'s own nameplate.',
  },
  {
    id: 'BC-B-ii. ★★★ no answer from the tracker falls to the nameplate',
    file: EB, tests: [T_EB],
    find: "    return { wh: prev?.wh ?? null, ratio: prev?.ratio ?? null, basis: 'unavailable', atMs: prev?.atMs ?? null };",
    to: "    return { wh: nameplateWh, ratio: 1, basis: 'unavailable', atMs: null }; /* MUTANT */",
    why: 'The silent nameplate again, by another door.',
  },
  {
    id: 'BC-B-iii. ★★ a slot with no nameplate keeps a stale figure',
    file: EB, tests: [T_EB],
    find: "  if (nameplateWh == null || !(nameplateWh > 0)) return { wh: null, ratio: null, basis: 'no-nameplate', atMs: null };",
    to: "  if (nameplateWh == null || !(nameplateWh > 0)) return { wh: prev?.wh ?? null, ratio: null, basis: 'no-nameplate', atMs: null }; /* MUTANT */",
    why: 'The line says the slot has no capacity figure while the check runs on one.',
  },
  {
    id: 'BC-B-iv. ★★★ the first figure is cached for the dark span',
    file: EB, tests: [T_EB],
    find: ASK,
    to: '    const next = prev ?? slotCapacity(nameplate, nameplate != null && nameplate > 0 ? deps.coreRatio(s.panelSn, s.sn, devices, nowMs) : null, prev); /* MUTANT */',
    why: 'A figure resolved before the tracker could answer (none) stands for the whole outage.',
  },
  {
    id: 'BC-B-v. ★★★ the daylight window counts the slot on its nameplate whatever was resolved',
    file: EB, tests: [T_PLANT, T_REC],
    find: '          const capWh = slotCapWh;',
    to: '          const capWh = finite(s.source.fullCap); /* MUTANT */',
    why: 'The line and the debug block show the held figure while the bound and the check run on 30,720 Wh.',
  },
  {
    id: 'BC-B-vi. ★★ capacity is resolved in daylight only',
    file: EB, tests: [T_PLANT],
    find: '      const slotCapWh = resolveCapacity(s, inferKey, snap.devices, nowMs);',
    to: '      const slotCapWh = sunUp(nowMs, site) ? resolveCapacity(s, inferKey, snap.devices, nowMs) : null; /* MUTANT */',
    why: 'A deploy or restart at night logs no basis until the first daylight window.',
  },
  {
    id: 'BC-B-vii. ★★★ only the first basis is logged',
    file: EB, tests: [T_EB],
    find: '    if (capacitySig(next) !== capacitySig(prev)) {',
    to: '    if (capacitySig(next) !== capacitySig(prev) && prev == null) { /* MUTANT */',
    why: 'A figure that later falls to the nameplate, or a tracker that stops answering, changes the count without a word.',
  },
  {
    id: 'BC-B-viii. ★★ a change of basis with the same figure is not logged',
    file: EB, tests: [T_EB],
    find: "(c == null ? '' : `${c.basis}:${c.wh == null ? '' : Math.round(c.wh)}`);",
    to: "(c == null ? '' : `${c.wh == null ? '' : Math.round(c.wh)}`); /* MUTANT */",
    why: 'A slot that moves from its Core\'s own ratio to the lowest known one at the same Wh goes unreported.',
  },
  {
    id: 'BC-B-ix. ★★ a slot\'s capacity entry outlives its dark span',
    file: EB, tests: [T_EB, T_PLANT],
    find: '    for (const k of [...capacity.keys()]) if (!darkKeys.has(k)) capacity.delete(k);',
    to: '    /* MUTANT */',
    why: 'A second dark span of the same slot on the same figure logs nothing, and the debug block shows a capacity for a slot that is not bridged.',
  },
  {
    id: 'BC-B-x. ★★ a capacity line that cannot be logged stops the rollup',
    file: EB, tests: [T_EB],
    find: '      try { deps.log(slotCapacityLogText(bridgeSlotLabel(devices, s.panelSn, s.slot), next, nameplate)); } catch { /* the figure stands without its line */ }',
    to: '      deps.log(slotCapacityLogText(bridgeSlotLabel(devices, s.panelSn, s.slot), next, nameplate)); /* MUTANT */',
    why: 'One failed log write and that rollup books nothing for any dark slot.',
  },
  {
    id: 'BC-B-xi. ★★ the held instant is printed without a range guard',
    file: EB, tests: [T_EB],
    find: "  return atMs != null && Number.isFinite(atMs) && Math.abs(atMs) <= 8.64e15 ? `of ${new Date(atMs).toISOString()}` : 'at an unknown time';",
    to: "  return atMs != null ? `of ${new Date(atMs).toISOString()}` : 'at an unknown time'; /* MUTANT */",
    why: 'A finite instant outside the Date range in the tracker\'s file throws RangeError while the line is built.',
  },
  {
    id: 'BC-B-xii. ★★★ the slot label prints the panel\'s serial',
    file: EB, tests: [T_EB, T_PLANT],
    find: '  if (allShp2s(devices).length <= 1) return `slot ${slot}`;',
    to: '  if (allShp2s(devices).length <= 1) return `panel ${panelSn} slot ${slot}`; /* MUTANT */',
    why: 'A serial in a line written to be quoted.',
  },
  {
    id: 'BC-B-xiii. ★★ with two panels, a panel named by its serial is printed by name',
    file: EB, tests: [T_EB],
    find: "name.trim() !== '' && !name.includes(panelSn) ? name.trim() : 'panel'",
    to: "name.trim() !== '' ? name.trim() : 'panel' /* MUTANT */",
    why: 'The device name falls back to the serial when the cloud gives none: the label would carry it.',
  },
  {
    id: 'BC-B-xiv. ★★ the debug block serves no capacity',
    file: EB, tests: [T_EB, T_PLANT],
    find: '        capacity: [...capacity.entries()].map(([k, c]) => {',
    to: '        capacity: [...capacity.entries()].slice(0, 0).map(([k, c]) => { /* MUTANT */',
    why: 'The figure the check runs on cannot be read back from /api/debug/battery-lifetime.',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs).
import { runMutantsParallel } from './lib/mutateParallel.mjs';
await runMutantsParallel({ name: 'mutate-bridge-capacity', mutants: MUTANTS, subset: [], root: REPO, perMutantTests: true, typecheck: true, fullSuite: false });
