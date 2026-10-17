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
 *   node scripts/mutate-energyflow-offline.mjs
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MODEL = resolve(REPO, 'web/src/cards/energyFlowModel.ts');
const CARD = resolve(REPO, 'web/src/cards/EnergyFlow.tsx');
const SUBSET = [
  'test/energyFlowCoresOffline.test.ts',
  'test/energyFlowModel.test.ts',
];

const MUTANTS = [
  {
    id: 'O-i. ★★★ the house-on-grid rule fires on the Cores’ absence again',
    file: MODEL,
    find: '  const coresSeenIdle = !coresDelivering && dpus.length > 0 && unmeteredCores === 0;',
    to: '  const coresSeenIdle = !coresDelivering; /* MUTANT */',
    why: 'The pre-fix rule: with no Core reporting and the frame carrying no slot figures, the whole house is drawn as grid import against a main that measured 0 W.',
  },
  {
    id: 'O-ii. ★★★ the rule no longer needs a Core’s OWN meter',
    file: MODEL,
    find: '  const coresSeenIdle = !coresDelivering && dpus.length > 0 && unmeteredCores === 0;',
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
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs).
// fullSuite: false — the subset holds every test that guards these mutants, so a kill comes
// from the subset.
import { runMutantsParallel } from './lib/mutateParallel.mjs';
// typecheck: true — a mutant that does not compile is reported INVALID, never counted as a kill.
await runMutantsParallel({ name: 'mutate-energyflow-offline', mutants: MUTANTS, subset: SUBSET, root: REPO, fullSuite: false, typecheck: true });
