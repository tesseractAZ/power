#!/usr/bin/env node
/**
 * mutate-energyflow-offline.mjs — v1.188.1: the Energy flow card with the Cores' own meters
 * absent and the panel fresh (web/src/cards/energyFlowModel.ts, EnergyFlow.tsx).
 *
 * Live 2026-10-16 20:04 MST: every Core cloud-offline, the panel fresh (main 0 W, its slots
 * delivering 3.4 kW, the house 3.39 kW). The card drew "GRID 3.39 kW importing" and a 3390 W
 * grid → Loads edge beside "Batteries (0 DPU) — idle": the house-on-grid rule read the Cores'
 * absent meters as "delivering nothing".
 *
 *   O-i     the house-on-grid rule fires on the Cores' absence again (the pre-fix rule)
 *   O-ii    the rule no longer needs a Core's OWN meter (all-panel frames infer grid)
 *   O-iii   a connected Core with no figure from either meter reads as idle
 *   O-iv    the panel's slot delivery is not counted as the Cores' AC output
 *   O-v     the slot sign is read the wrong way round (charging taken as delivering)
 *   O-vi    the panel's slot input is not counted as the Cores' grid draw
 *   O-vii   the Batteries node's net ignores the panel-metered Cores
 *   O-viii  the slots' battery percentages are not averaged in
 *   O-ix    a frozen panel's slots are read as live
 *   O-x     a Core that reports is counted again from its slot
 *   O-xi    a disconnected slot is drawn
 *   O-xii   a slot with no figure is drawn via the panel
 *   O-xiii  viaPanelCount is not reported
 *   O-xiv   the title drops "via panel" (b: still counts "0 DPU"; c: drops a 0 count with nothing via panel)
 *   O-xv    the subtitle says "discharging" for a panel figure that carries PV
 *   O-xvi   the card builds its own title, not the model's
 *   O-xvii  the card builds its own subtitle, not the model's
 *
 * Review round (v1.188.1):
 *   F-i     a Core listed online on a frozen meter is read on its own meter again
 *   F-ii    a frozen Core's PV is counted
 *   F-iii   the house-on-grid rule counts the Cores listed, not the Cores on their own meters
 *   F-iv    the server never marks a Core frozen
 *   F-v     the content clock's 5-min window is exclusive
 *   F-vi    the server drops dpuFrozen from the slots
 *   P-i     a second panel the server judges not fresh is read as live
 *   P-ii    the server drops readbackFresh from the panels
 *   P-iii   snapshotForClient sends the second panel without the verdicts
 *   G-i     a silent panel's slots are read (the gate's "live" half)
 *   C-i     the slots are summed unclamped (a charging slot cancels a delivering one)
 *   C-ii    the slots' delivery is clamped after summing
 *   C-iii   the slots' input is clamped after summing
 *   S-i     no Core reporting reads "0 W" of PV again
 *   S-ii    any Core via the panel hides the reporting Cores' PV
 *   S-iii   pvUnreported is not reported
 *   S-iv    the Solar subtitle drops "N of M Cores"
 *   S-v     the card hard-codes the Solar subtitle
 *   T-i     the timers trust the Cores' sum with a home Core dark
 *   T-ii    the timers trust a frozen Core's sum
 *   T-iii   the slot sign is not negated in the bound
 *   T-iv    a stale panel's slots bound the pool
 *   T-v     a slot with no figure counts as 0 W
 *   T-vi    a reporting Core's slot is read instead of its own meter
 *   T-vii   no slot to read is a 0 W bound
 *   T-viii  the deadband edges are exclusive (charge / discharge)
 *   T-ix    /api/ha-state gates the charge timer on the Cores' sum again
 *   T-x     the console gates CHG on the Cores' sum again
 *   T-xi    the console's DCH is ungated
 *
 *   node scripts/mutate-energyflow-offline.mjs
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MODEL = resolve(REPO, 'web/src/cards/energyFlowModel.ts');
const CARD = resolve(REPO, 'web/src/cards/EnergyFlow.tsx');
const MEMB = resolve(REPO, 'server/src/shp2Membership.ts');
const IDX = resolve(REPO, 'server/src/index.ts');
const CONSOLE = resolve(REPO, 'server/src/telnet/plant/console.ts');
const SUBSET = [
  'test/energyFlowCoresOffline.test.ts',
  'test/energyFlowModel.test.ts',
  'test/coresDarkServerVerdicts.test.ts',
];

const MUTANTS = [
  {
    id: 'O-i. ★★★ the house-on-grid rule fires on the Cores’ absence again',
    file: MODEL,
    find: '  const coresSeenIdle = !coresDelivering && ownMeter.size > 0 && unmeteredCores === 0;',
    to: '  const coresSeenIdle = !coresDelivering; /* MUTANT */',
    why: 'The pre-fix rule: with no Core reporting and the frame carrying no slot figures, the whole house is drawn as grid import against a main that measured 0 W.',
  },
  {
    id: 'O-ii. ★★★ the rule no longer needs a Core’s OWN meter',
    file: MODEL,
    find: '  const coresSeenIdle = !coresDelivering && ownMeter.size > 0 && unmeteredCores === 0;',
    to: '  const coresSeenIdle = !coresDelivering && unmeteredCores === 0; /* MUTANT */',
    why: 'Every figure is from the panel’s one frame, whose main measured no grid, yet idle slots put the house on the grid.',
  },
  {
    id: 'O-iii. ★★ a connected Core with no figure from either meter reads as idle',
    file: MODEL,
    find: '  const unmeteredCores = silentSlots.length - viaPanel.length;',
    to: '  const unmeteredCores = 0; /* MUTANT */',
    why: 'Two idle Cores stand in for three: the third, unmeasured, Core’s delivery is drawn as grid import.',
  },
  {
    id: 'O-iv. ★★★ the panel’s slot delivery is not counted as the Cores’ AC output',
    file: MODEL,
    find: '  const acOut = ownAcOut + viaPanel.reduce((t, x) => t + Math.max(0, -x.w), 0);',
    to: '  const acOut = ownAcOut; /* MUTANT */',
    why: 'The 10-16 20:04 house is drawn with nothing feeding it while the slots deliver 3.4 kW.',
  },
  {
    id: 'O-v. ★★ the slot sign is read the wrong way round',
    file: MODEL,
    find: '  const acOut = ownAcOut + viaPanel.reduce((t, x) => t + Math.max(0, -x.w), 0);',
    to: '  const acOut = ownAcOut + viaPanel.reduce((t, x) => t + Math.max(0, x.w), 0); /* MUTANT */',
    why: 'A force charge into the Cores is drawn as the Cores delivering to the house.',
  },
  {
    id: 'O-vi. ★★ the panel’s slot input is not counted as the Cores’ grid draw',
    file: MODEL,
    find: '  const acIn = ownAcIn + viaPanel.reduce((t, x) => t + Math.max(0, x.w), 0);',
    to: '  const acIn = ownAcIn; /* MUTANT */',
    why: 'A 16 kW force charge with the Cores offline draws no grid → Batteries edge and a Grid node of the house alone.',
  },
  {
    id: 'O-vii. ★★ the Batteries node’s net ignores the panel-metered Cores',
    file: MODEL,
    find: '  const batNet = ownBatNet - viaPanel.reduce((t, x) => t + x.w, 0);',
    to: '  const batNet = ownBatNet; /* MUTANT */',
    why: '"Batteries — idle" beside a 3.4 kW Batteries → Loads edge (the 10-16 dashboard).',
  },
  {
    id: 'O-viii. ★ the slots’ battery percentages are not averaged in',
    file: MODEL,
    find: '  const socVals = [...ownSocVals, ...viaPanel.map((x) => x.s.batteryPercentage)]',
    to: '  const socVals = [...ownSocVals] /* MUTANT */',
    why: 'The Batteries node reads "—" while the panel reports every Core’s percentage.',
  },
  {
    id: 'O-ix. ★★★ a frozen panel’s slots are read as live',
    file: MODEL,
    find: "  const viaPanel = panelState === 'ok'",
    to: '  const viaPanel = true /* MUTANT */',
    why: 'A cloud-shadowed panel’s last slot figures are drawn as the Cores delivering now.',
  },
  {
    id: 'O-x. ★★ a Core that reports is counted again from its slot',
    file: MODEL,
    find: '    .filter(({ s }) => s.isConnected && !!s.sn && !ownMeter.has(s.sn));',
    to: '    .filter(({ s }) => s.isConnected && !!s.sn); /* MUTANT */',
    why: 'A minute-old panel frame doubles the Cores’ delivery and hides the hand-over to the grid.',
  },
  {
    id: 'O-xi. ★ a disconnected slot is drawn',
    file: MODEL,
    find: '    .filter(({ s }) => s.isConnected && !!s.sn && !ownMeter.has(s.sn));',
    to: '    .filter(({ s }) => !!s.sn && !ownMeter.has(s.sn)); /* MUTANT */',
    why: 'A Core the panel does not count as a source is drawn in the home’s Batteries node.',
  },
  {
    id: 'O-xii. ★★ a slot with no figure is drawn via the panel',
    file: MODEL,
    find: "    ? silentSlots.filter((x): x is { s: Shp2EnergySource; w: number } => typeof x.w === 'number' && Number.isFinite(x.w))",
    to: '    ? (silentSlots as Array<{ s: Shp2EnergySource; w: number }>) /* MUTANT */',
    why: 'A frame without slot figures is drawn as three Cores via the panel delivering NaN.',
  },
  {
    id: 'O-xiii. ★ viaPanelCount is not reported',
    file: MODEL,
    find: '    viaPanelCount: viaPanel.length,',
    to: '    viaPanelCount: 0, /* MUTANT */',
    why: 'The Batteries node shows a panel figure under the Cores’ wording, "0 DPU … discharging".',
  },
  {
    id: 'O-xiv. ★★ the title drops "via panel"',
    file: MODEL,
    find: '  const panelPart = m.viaPanelCount > 0 ? [`${m.viaPanelCount} via panel`] : [];',
    to: '  const panelPart: string[] = []; /* MUTANT */',
    why: '"Batteries ()" beside a 3.4 kW discharge: the figure’s source is not named.',
  },
  {
    id: 'O-xiv-b. ★ with every Core via the panel, the title still counts "0 DPU"',
    file: MODEL,
    find: '  const own = m.dpuCount > 0 || m.viaPanelCount === 0 ? [`${m.dpuCount} DPU`] : [];',
    to: '  const own = [`${m.dpuCount} DPU`]; /* MUTANT */',
    why: '"Batteries (0 DPU, 3 via panel)" reads as an empty node holding three batteries.',
  },
  {
    id: 'O-xiv-c. ★ with no Core reporting and none via the panel, the count disappears',
    file: MODEL,
    find: '  const own = m.dpuCount > 0 || m.viaPanelCount === 0 ? [`${m.dpuCount} DPU`] : [];',
    to: '  const own = m.dpuCount > 0 ? [`${m.dpuCount} DPU`] : []; /* MUTANT */',
    why: '"Batteries ()" when nothing reports: the node no longer says it holds no reading.',
  },
  {
    id: 'O-xv. ★ the subtitle says "discharging" for a panel figure that carries PV',
    file: MODEL,
    find: '  const acExchange = m.viaPanelCount > 0;',
    to: '  const acExchange = false; /* MUTANT */',
    why: 'By day a Core passing PV to the house while its packs charge reads as discharging.',
  },
  {
    id: 'O-xvi. ★★ the card builds its own title, not the model’s',
    file: CARD,
    find: '          title={batteriesTitle({ dpuCount, viaPanelCount, spareCount, membershipUnknown })}',
    to: "          title={`Batteries (${dpuCount} DPU${spareCount > 0 ? `, +${spareCount} spare` : membershipUnknown ? ', spares not yet identified' : ''})`} /* MUTANT */",
    why: 'The model is tested and the card ignores it: "via panel" never reaches the screen.',
  },
  {
    id: 'O-xvii. ★★ the card builds its own subtitle, not the model’s',
    file: CARD,
    find: '          subtitle={batteriesSubtitle({ batNet, viaPanelCount })}',
    to: "          subtitle={batNet > 5 ? `▼ ${fmtW(batNet)} discharging` : batNet < -5 ? `▲ ${fmtW(-batNet)} charging` : 'idle'} /* MUTANT */",
    why: 'The card says "discharging" for a figure the model reports as the Cores’ AC exchange.',
  },
  // ── review round ──────────────────────────────────────────────────────────
  {
    id: 'F-i. ★★★ a Core listed online on a frozen meter is read on its own meter again',
    file: MODEL,
    find: '  const metered = dpus.filter((d) => !frozenSns.has(d.sn));',
    to: '  const metered = dpus; /* MUTANT */',
    why: 'Three Cores frozen at 0 W read as "the Cores deliver nothing": the 10-16 false grid import through the stale half of the rule.',
  },
  {
    id: 'F-ii. ★ a frozen Core’s PV is counted',
    file: MODEL,
    find: '  const ownPv = metered.reduce((s, d) => s + (d.projection.pvTotalWatts ?? 0), 0);',
    to: '  const ownPv = dpus.reduce((s, d) => s + (d.projection.pvTotalWatts ?? 0), 0); /* MUTANT */',
    why: 'A frozen Core’s last PV figure is drawn as PV now.',
  },
  {
    id: 'F-iii. ★★ the house-on-grid rule counts the Cores listed, not the Cores on their own meters',
    file: MODEL,
    find: '  const coresSeenIdle = !coresDelivering && ownMeter.size > 0 && unmeteredCores === 0;',
    to: '  const coresSeenIdle = !coresDelivering && dpus.length > 0 && unmeteredCores === 0; /* MUTANT */',
    why: 'Frozen Cores (listed, projected) stand in for a Core’s own meter, and idle slots put the house on the grid against a main of 0 W.',
  },
  {
    id: 'F-iv. ★★★ the server never marks a Core frozen',
    file: MEMB,
    find: "  return dpu != null && dpu.online === true && dpu.projection?.kind === 'dpu' && !dpuContentFresh(dpu, nowMs);",
    to: '  return false; /* MUTANT */',
    why: 'The card keys on the server’s verdict and has no clock: without it a frozen Core is read on its own meter.',
  },
  {
    id: 'F-v. ★ the content clock’s window is exclusive',
    file: MEMB,
    find: "  return typeof t === 'number' && Number.isFinite(t) && t > 0 && nowMs - t <= SHP2_READBACK_STALE_MS;",
    to: "  return typeof t === 'number' && Number.isFinite(t) && t > 0 && nowMs - t < SHP2_READBACK_STALE_MS; /* MUTANT */",
    why: 'The window disagrees with the grid resolver’s (gridState coreContentFresh) at its edge.',
  },
  {
    id: 'F-vi. ★★ the server drops dpuFrozen from the slots',
    file: MEMB,
    find: '        dpuFrozen: isSourceDpuFrozen(src, devices, nowMs),',
    to: '        dpuFrozen: false, /* MUTANT */',
    why: 'The verdict is computed and never reaches the card.',
  },
  {
    id: 'P-i. ★★★ a second panel the server judges not fresh is read as live',
    file: MODEL,
    find: '      || panels.some((p) => p.readbackFresh === false)',
    to: '      || false /* MUTANT */',
    why: 'A second panel’s 3-hour-old slot figure is drawn as the Cores delivering now, and its frozen 88 % joins the SoC.',
  },
  {
    id: 'P-ii. ★★ the server drops readbackFresh from the panels',
    file: MEMB,
    find: '    readbackFresh: shp2ReadbackFresh(p, nowMs),',
    to: '    readbackFresh: true, /* MUTANT */',
    why: 'Every panel reads as fresh: the card cannot see a second panel whose quota keeps failing.',
  },
  {
    id: 'P-iii. ★★ snapshotForClient sends the second panel without the verdicts',
    file: IDX,
    find: '  for (const p of secondaryShp2s(s.devices)) devices[p.sn] = panelForClient(p, s.devices, nowMs);',
    to: '  for (const p of secondaryShp2s(s.devices)) devices[p.sn] = p; /* MUTANT */',
    why: 'The pure helper is tested and the production path skips it for every panel but the house one.',
  },
  {
    id: 'G-i. ★★ a silent panel’s slots are read',
    file: MODEL,
    find: "  const viaPanel = panelState === 'ok'",
    to: "  const viaPanel = panelState !== 'frozen' /* MUTANT */",
    why: 'A frame with no house reading draws a 3 kW Batteries → Loads edge into a Loads node reading "—".',
  },
  {
    id: 'C-i. ★★ the slots are summed unclamped',
    file: MODEL,
    find: '  const acOut = ownAcOut + viaPanel.reduce((t, x) => t + Math.max(0, -x.w), 0);',
    to: '  const acOut = ownAcOut + viaPanel.reduce((t, x) => t - x.w, 0); /* MUTANT */',
    why: 'One Core force-charging cancels another’s delivery, and the whole house is drawn on the grid.',
  },
  {
    id: 'C-ii. ★★ the slots’ delivery is clamped after summing',
    file: MODEL,
    find: '  const acOut = ownAcOut + viaPanel.reduce((t, x) => t + Math.max(0, -x.w), 0);',
    to: '  const acOut = ownAcOut + Math.max(0, viaPanel.reduce((t, x) => t - x.w, 0)); /* MUTANT */',
    why: 'A charging slot hides a delivering one: 1.5 kW of delivery drawn as 0.',
  },
  {
    id: 'C-iii. ★★ the slots’ input is clamped after summing',
    file: MODEL,
    find: '  const acIn = ownAcIn + viaPanel.reduce((t, x) => t + Math.max(0, x.w), 0);',
    to: '  const acIn = ownAcIn + Math.max(0, viaPanel.reduce((t, x) => t + x.w, 0)); /* MUTANT */',
    why: 'A delivering slot shrinks another’s grid charge: 3 kW into a Core drawn as 1.5 kW.',
  },
  {
    id: 'S-i. ★★ no Core reporting reads "0 W" of PV again',
    file: MODEL,
    find: '  const pv: number | null = ownMeter.size === 0 && silentSlots.length > 0 ? null : ownPv;',
    to: '  const pv: number | null = ownPv; /* MUTANT */',
    why: 'A missing PV meter is drawn as a reading beside an "out" figure that carries that PV.',
  },
  {
    id: 'S-ii. ★ any Core via the panel hides the reporting Cores’ PV',
    file: MODEL,
    find: '  const pv: number | null = ownMeter.size === 0 && silentSlots.length > 0 ? null : ownPv;',
    to: '  const pv: number | null = silentSlots.length > 0 ? null : ownPv; /* MUTANT */',
    why: 'The PV two reporting Cores measured is thrown away because a third is dark.',
  },
  {
    id: 'S-iii. ★ pvUnreported is not reported',
    file: MODEL,
    find: '    pvUnreported: silentSlots.length,',
    to: '    pvUnreported: 0, /* MUTANT */',
    why: 'Two Cores’ PV is labelled as the whole array.',
  },
  {
    id: 'S-iv. ★ the Solar subtitle drops "N of M Cores"',
    file: MODEL,
    find: '  if (m.pvUnreported > 0) return `${m.dpuCount} of ${m.dpuCount + m.pvUnreported} Cores`;',
    to: '  /* MUTANT */',
    why: 'A partial PV figure reads "42 panels".',
  },
  {
    id: 'S-v. ★ the card hard-codes the Solar subtitle',
    file: CARD,
    find: 'subtitle={solarSubtitle({ pv, dpuCount, pvUnreported })}',
    to: 'subtitle="42 panels" /* MUTANT */',
    why: 'The model is tested and the card ignores it.',
  },
  {
    id: 'T-i. ★★★ the timers trust the Cores’ sum with a home Core dark',
    file: MEMB,
    find: '  if (homeCoreCoverage(devices).complete && !frozen) {',
    to: '  if (!frozen) { /* MUTANT */',
    why: 'Every Core offline sums to 0 W, and "38 min to full" is published during a 3.4 kW drain (10-16 20:04).',
  },
  {
    id: 'T-ii. ★★ the timers trust a frozen Core’s sum',
    file: MEMB,
    find: '  if (homeCoreCoverage(devices).complete && !frozen) {',
    to: '  if (homeCoreCoverage(devices).complete) { /* MUTANT */',
    why: 'A Core listed online on a frozen 0 W reads as "not discharging" while its slot delivers.',
  },
  {
    id: 'T-iii. ★★★ the slot sign is not negated in the bound',
    file: MEMB,
    find: "      watts += panelFresh && typeof w === 'number' && Number.isFinite(w) ? -w : Infinity;",
    to: "      watts += panelFresh && typeof w === 'number' && Number.isFinite(w) ? w : Infinity; /* MUTANT */",
    why: 'A drain through the slots reads as a charge: the charge timer during the drain, the discharge timer hidden.',
  },
  {
    id: 'T-iv. ★★ a stale panel’s slots bound the pool',
    file: MEMB,
    find: '    const panelFresh = shp2ReadbackFresh(p, nowMs);',
    to: '    const panelFresh = true; /* MUTANT */',
    why: 'A frozen frame’s force charge keeps proving a charge after it ended.',
  },
  {
    id: 'T-v. ★★ a slot with no figure counts as 0 W',
    file: MEMB,
    find: "      watts += panelFresh && typeof w === 'number' && Number.isFinite(w) ? -w : Infinity;",
    to: "      watts += panelFresh && typeof w === 'number' && Number.isFinite(w) ? -w : 0; /* MUTANT */",
    why: 'An unmeasured Core reads as idle: the absence this release removes.',
  },
  {
    id: 'T-vi. ★★ a reporting Core’s slot is read instead of its own meter',
    file: MEMB,
    find: "      if (d?.online === true && d.projection?.kind === 'dpu' && dpuContentFresh(d, nowMs)) {",
    to: "      if (d?.online === true && d.projection?.kind === 'dpu' && dpuContentFresh(d, Infinity)) { /* MUTANT */",
    why: 'The slower slot meter replaces a Core’s exact pack net (and its PV pass-through hides a charge).',
  },
  {
    id: 'T-vii. ★★ no slot to read is a 0 W bound',
    file: MEMB,
    find: '  if (seen.size === 0) watts = Infinity;',
    to: '  /* MUTANT */',
    why: 'With no panel projected and a Core offline, nothing measured reads as "not discharging".',
  },
  {
    id: 'T-viii. ★ the deadband edges are exclusive',
    file: MEMB,
    find: '  return { charge: watts <= BACKUP_TIMER_DEADBAND_W, discharge: watts >= -BACKUP_TIMER_DEADBAND_W, basis };',
    to: '  return { charge: watts < BACKUP_TIMER_DEADBAND_W, discharge: watts > -BACKUP_TIMER_DEADBAND_W, basis }; /* MUTANT */',
    why: 'The v0.15.12 deadband publishes both timers at exactly ±50 W; this moves the edge.',
  },
  {
    id: 'T-ix. ★★★ /api/ha-state gates the charge timer on the Cores’ sum again',
    file: IDX,
    find: '    backup_charge_minutes: timers.charge ? (shp2?.projection.backupChargeTimeMin ?? null) : null,',
    to: '    backup_charge_minutes: fleetBatteryNet > 50 ? null : (shp2?.projection.backupChargeTimeMin ?? null), /* MUTANT */',
    why: 'The tested gate is bypassed by the published payload.',
  },
  {
    id: 'T-x. ★★★ the console gates CHG on the Cores’ sum again',
    file: CONSOLE,
    find: '    const chMin = timers.charge ? p.backupChargeTimeMin : null;',
    to: '    const chMin = batNet > 50 ? null : p.backupChargeTimeMin; /* MUTANT */',
    why: '"▲ CHG 38m" beside a 0 W BATT.P.NET while the pool drains through the panel.',
  },
  {
    id: 'T-xi. ★★ the console’s DCH is ungated',
    file: CONSOLE,
    find: '    const dchMin = timers.discharge ? p.backupDischargeTimeMin : null;',
    to: '    const dchMin = p.backupDischargeTimeMin; /* MUTANT */',
    why: 'A time to reserve during a force charge, where /api/ha-state publishes none.',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs).
// fullSuite: false — the subset holds every test that guards these mutants, so a kill comes
// from the subset.
import { runMutantsParallel } from './lib/mutateParallel.mjs';
// typecheck: true — a mutant that does not compile is reported INVALID, never counted as a kill.
await runMutantsParallel({ name: 'mutate-energyflow-offline', mutants: MUTANTS, subset: SUBSET, root: REPO, fullSuite: false, typecheck: true });
