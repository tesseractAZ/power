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
 * Review round 2 (v1.188.1):
 *   M-i     with the Cores' delivery unmeasured, the grid is given the whole house again
 *   M-ii    the main is drawn without the Cores' own draw taken out
 *   B-i     a frame behind the Cores' own meters is never detected
 *   B-ii    the meters' tolerance loses its 150 W floor
 *   B-iii   the meters' tolerance loses its 20 % share
 *   B-iv    a reporting Core's own exchange is read with the wrong sign
 *   B-v     one panel's frame behind drops every panel's dark slots
 *   B-vi    a behind frame's dark slots still count as the Cores' grid draw
 *   B-vii   a frozen Core's meter judges the frame
 *   F-vii   a frozen Core's own AC input is counted as the Cores' grid draw
 *   T-xii   a disconnected slot's Core bounds the pool
 *   T-xiii  a Core listed by two panels is counted twice
 *   T-xiv   the bound reads the poll's pack flow, not the stream's
 *   T-xv    an offline Core with a recent projection is read on its own meter
 *   T-xvi   the bound leaves out each dark Core's own draw (the reserve hold reads as a charge)
 *   V-i     the console reads the Cores-only sums again, not the published figures
 *   V-ii    the console's BATT.P.NET reads IDLE while the sensors are unknown
 *   V-iii   the console's mimic draws the battery idle while the sensors are unknown
 *
 * Review round 3 (v1.188.1): one verdict per Core across the alarm guard, the timers, the card
 * and the sensors
 *   W-i     the at-floor guard counts a frozen-online Core as reporting again
 *   W-ii    coverage with a clock ignores the content clock
 *   W-iii   the bound takes no PV out of a slot the bridge reads as measured
 *   W-iv    the bound's own-meter test ignores the bridge's verdict
 *   W-v     the 'cores' basis ignores the verdict (a marked Core's held net is summed)
 *   W-vi    /api/ha-state's timers ignore the verdicts
 *   W-vii   the console's RUN line ignores the verdicts
 *   W-viii  the console's flow carries no verdicts
 *   W-ix    panelForClient drops the bridge's verdicts
 *   W-x     snapshotForClient sends the house panel without the verdicts
 *   W-xi    the card ignores the ownReading verdict
 *   W-xii   the card ignores a slot's measured PV
 *   W-xiii  the Solar node stays "—" with only measured slot PV
 *   W-xiv   pvUnreported counts the measured slots
 *   W-xv    the Solar subtitle leaves out the measured slots
 *   W-xvi   the card passes no pvViaPanel to the Solar subtitle
 *   W-xvii  a measured slot's pack net keeps its PV in
 *   W-xviii the subtitle reads "in" / "out" with every via-panel slot measured
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
const TYPES = resolve(REPO, 'server/src/telnet/plant/types.ts');
const GRID = resolve(REPO, 'server/src/gridState.ts');
const SUBSET = [
  'test/energyFlowCoresOffline.test.ts',
  'test/energyFlowModel.test.ts',
  'test/coresDarkServerVerdicts.test.ts',
  'test/poolCoverageGate.test.ts',
  'test/energyBridge.test.ts',
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
    find: '  const acOut = ownAcOut + viaFlow.reduce((t, x) => t + Math.max(0, -x.w), 0);',
    to: '  const acOut = ownAcOut; /* MUTANT */',
    why: 'The 10-16 20:04 house is drawn with nothing feeding it while the slots deliver 3.4 kW.',
  },
  {
    id: 'O-v. ★★ the slot sign is read the wrong way round',
    file: MODEL,
    find: '  const acOut = ownAcOut + viaFlow.reduce((t, x) => t + Math.max(0, -x.w), 0);',
    to: '  const acOut = ownAcOut + viaFlow.reduce((t, x) => t + Math.max(0, x.w), 0); /* MUTANT */',
    why: 'A force charge into the Cores is drawn as the Cores delivering to the house.',
  },
  {
    id: 'O-vi. ★★ the panel’s slot input is not counted as the Cores’ grid draw',
    file: MODEL,
    find: '  const acIn = ownAcIn + viaFlow.reduce((t, x) => t + Math.max(0, x.w), 0);',
    to: '  const acIn = ownAcIn; /* MUTANT */',
    why: 'A 16 kW force charge with the Cores offline draws no grid → Batteries edge and a Grid node of the house alone.',
  },
  {
    id: 'O-vii. ★★ the Batteries node’s net ignores the panel-metered Cores',
    file: MODEL,
    find: '  const batNet = ownBatNet - viaFlow.reduce((t, x) => t + x.w, 0) - slotPv;',
    to: '  const batNet = ownBatNet - slotPv; /* MUTANT */',
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
    find: "    ? silentSlots.filter((x): x is { p: Shp2; s: Shp2EnergySource; w: number } => typeof x.w === 'number' && Number.isFinite(x.w))",
    to: '    ? (silentSlots as Array<{ p: Shp2; s: Shp2EnergySource; w: number }>) /* MUTANT */',
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
    find: '  const acExchange = m.viaPanelCount > (m.pvViaPanel ?? 0);',
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
    find: '          subtitle={batteriesSubtitle({ batNet, viaPanelCount, pvViaPanel })}',
    to: "          subtitle={batNet > 5 ? `▼ ${fmtW(batNet)} discharging` : batNet < -5 ? `▲ ${fmtW(-batNet)} charging` : 'idle'} /* MUTANT */",
    why: 'The card says "discharging" for a figure the model reports as the Cores’ AC exchange.',
  },
  // ── review round ──────────────────────────────────────────────────────────
  {
    id: 'F-i. ★★★ a Core listed online on a frozen meter is read on its own meter again',
    file: MODEL,
    find: '    : dpus.filter((d) => !frozenSns.has(d.sn));',
    to: '    : dpus; /* MUTANT */',
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
    find: "  const t = d?.contentChangedAtMs;\n  return typeof t === 'number' && Number.isFinite(t) && t > 0 && nowMs - t <= SHP2_READBACK_STALE_MS;",
    to: "  const t = d?.contentChangedAtMs;\n  return typeof t === 'number' && Number.isFinite(t) && t > 0 && nowMs - t < SHP2_READBACK_STALE_MS; /* MUTANT */",
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
    find: '  for (const p of secondaryShp2s(s.devices)) devices[p.sn] = panelForClient(p, s.devices, nowMs, verdicts);',
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
    find: '  const acOut = ownAcOut + viaFlow.reduce((t, x) => t + Math.max(0, -x.w), 0);',
    to: '  const acOut = ownAcOut + viaFlow.reduce((t, x) => t - x.w, 0); /* MUTANT */',
    why: 'One Core force-charging cancels another’s delivery, and the whole house is drawn on the grid.',
  },
  {
    id: 'C-ii. ★★ the slots’ delivery is clamped after summing',
    file: MODEL,
    find: '  const acOut = ownAcOut + viaFlow.reduce((t, x) => t + Math.max(0, -x.w), 0);',
    to: '  const acOut = ownAcOut + Math.max(0, viaFlow.reduce((t, x) => t - x.w, 0)); /* MUTANT */',
    why: 'A charging slot hides a delivering one: 1.5 kW of delivery drawn as 0.',
  },
  {
    id: 'C-iii. ★★ the slots’ input is clamped after summing',
    file: MODEL,
    find: '  const acIn = ownAcIn + viaFlow.reduce((t, x) => t + Math.max(0, x.w), 0);',
    to: '  const acIn = ownAcIn + Math.max(0, viaFlow.reduce((t, x) => t + x.w, 0)); /* MUTANT */',
    why: 'A delivering slot shrinks another’s grid charge: 3 kW into a Core drawn as 1.5 kW.',
  },
  {
    id: 'S-i. ★★ no Core reporting reads "0 W" of PV again',
    file: MODEL,
    find: '  const pv: number | null = ownMeter.size === 0 && viaPv.length === 0 && silentSlots.length > 0 ? null : ownPv + slotPv;',
    to: '  const pv: number | null = ownPv + slotPv; /* MUTANT */',
    why: 'A missing PV meter is drawn as a reading beside an "out" figure that carries that PV.',
  },
  {
    id: 'S-ii. ★ any Core via the panel hides the reporting Cores’ PV',
    file: MODEL,
    find: '  const pv: number | null = ownMeter.size === 0 && viaPv.length === 0 && silentSlots.length > 0 ? null : ownPv + slotPv;',
    to: '  const pv: number | null = silentSlots.length > 0 ? null : ownPv + slotPv; /* MUTANT */',
    why: 'The PV two reporting Cores measured is thrown away because a third is dark.',
  },
  {
    id: 'S-iii. ★ pvUnreported is not reported',
    file: MODEL,
    find: '    pvUnreported: silentSlots.length - viaPv.length,',
    to: '    pvUnreported: 0, /* MUTANT */',
    why: 'Two Cores’ PV is labelled as the whole array.',
  },
  {
    id: 'S-iv. ★ the Solar subtitle drops "N of M Cores"',
    file: MODEL,
    find: '  if (m.pvUnreported > 0) return `${covered} of ${covered + m.pvUnreported} Cores`;',
    to: '  /* MUTANT */',
    why: 'A partial PV figure reads "42 panels".',
  },
  {
    id: 'S-v. ★ the card hard-codes the Solar subtitle',
    file: CARD,
    find: 'subtitle={solarSubtitle({ pv, dpuCount, pvUnreported, pvViaPanel })}',
    to: 'subtitle="42 panels" /* MUTANT */',
    why: 'The model is tested and the card ignores it.',
  },
  {
    id: 'T-i. ★★★ the timers trust the Cores’ sum with a home Core dark',
    file: MEMB,
    find: '  if (homeCoreCoverage(devices).complete && !frozen && (!verdicts || listings.every((l) => verdicts.own.has(l.src.sn as string)))) {',
    to: '  if (!frozen && (!verdicts || listings.every((l) => verdicts.own.has(l.src.sn as string)))) { /* MUTANT */',
    why: 'Every Core offline sums to 0 W, and "38 min to full" is published during a 3.4 kW drain (10-16 20:04).',
  },
  {
    id: 'T-ii. ★★ the timers trust a frozen Core’s sum',
    file: MEMB,
    find: '  if (homeCoreCoverage(devices).complete && !frozen && (!verdicts || listings.every((l) => verdicts.own.has(l.src.sn as string)))) {',
    to: '  if (homeCoreCoverage(devices).complete && (!verdicts || listings.every((l) => verdicts.own.has(l.src.sn as string)))) { /* MUTANT */',
    why: 'A Core listed online on a frozen 0 W reads as "not discharging" while its slot delivers.',
  },
  {
    id: 'T-iii. ★★★ the slot sign is not negated in the bound',
    file: MEMB,
    find: "    watts += shp2ReadbackFresh(p, nowMs) && typeof w === 'number' && Number.isFinite(w) ? -w - pv + SLOT_UNMETERED_DRAW_W : Infinity;",
    to: "    watts += shp2ReadbackFresh(p, nowMs) && typeof w === 'number' && Number.isFinite(w) ? w - pv + SLOT_UNMETERED_DRAW_W : Infinity; /* MUTANT */",
    why: 'A drain through the slots reads as a charge: the charge timer during the drain, the discharge timer hidden.',
  },
  {
    id: 'T-iv. ★★ a stale panel’s slots bound the pool',
    file: MEMB,
    find: "    watts += shp2ReadbackFresh(p, nowMs) && typeof w === 'number' && Number.isFinite(w) ? -w - pv + SLOT_UNMETERED_DRAW_W : Infinity;",
    to: "    watts += typeof w === 'number' && Number.isFinite(w) ? -w - pv + SLOT_UNMETERED_DRAW_W : Infinity; /* MUTANT */",
    why: 'A frozen frame’s force charge keeps proving a charge after it ended.',
  },
  {
    id: 'T-v. ★★ a slot with no figure counts as 0 W',
    file: MEMB,
    find: "    watts += shp2ReadbackFresh(p, nowMs) && typeof w === 'number' && Number.isFinite(w) ? -w - pv + SLOT_UNMETERED_DRAW_W : Infinity;",
    to: "    watts += shp2ReadbackFresh(p, nowMs) && typeof w === 'number' && Number.isFinite(w) ? -w - pv + SLOT_UNMETERED_DRAW_W : 0; /* MUTANT */",
    why: 'An unmeasured Core reads as idle: the absence this release removes.',
  },
  {
    id: 'T-vi. ★★ a reporting Core’s slot is read instead of its own meter',
    file: MEMB,
    find: '    return verdicts ? verdicts.own.has(sn) : d.online === true && dpuContentFresh(d, nowMs);',
    to: '    return verdicts ? verdicts.own.has(sn) : d.online === true && dpuContentFresh(d, Infinity); /* MUTANT */',
    why: 'The slower slot meter replaces a Core’s exact pack net (and its PV pass-through hides a charge).',
  },
  {
    id: 'T-vii. ★★ no slot to read is a 0 W bound',
    file: MEMB,
    find: '  if (listings.length === 0) watts = Infinity;',
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
    // The Cores-only sum, as the pre-fix gate read it (the console's own battery figure is the
    // published, bridged one since the review).
    to: '    const chMin = dpus.reduce((t, d) => t + (d.projection.packs ?? []).reduce((u, pk) => u + (pk.outputWatts ?? 0) - (pk.inputWatts ?? 0), 0), 0) > 50 ? null : p.backupChargeTimeMin; /* MUTANT */',
    why: '"▲ CHG 38m" beside a 0 W BATT.P.NET while the pool drains through the panel.',
  },
  {
    id: 'T-xi. ★★ the console’s DCH is ungated',
    file: CONSOLE,
    find: '    const dchMin = timers.discharge ? p.backupDischargeTimeMin : null;',
    to: '    const dchMin = p.backupDischargeTimeMin; /* MUTANT */',
    why: 'A time to reserve during a force charge, where /api/ha-state publishes none.',
  },
  // ── review round 2 ────────────────────────────────────────────────────────
  {
    id: 'M-i. ★★★ with the Cores’ delivery unmeasured, the grid is given the whole house again',
    file: MODEL,
    find: "    gridToHouseW = gridState !== 'active' ? 0 : coresSeenIdle ? load : Math.min(load, Math.max(0, homeGridW - coresAcIn));",
    to: "    gridToHouseW = gridState === 'active' ? load : 0; /* MUTANT */",
    why: 'A fresh main of 500 W below a 3.39 kW house is drawn as "GRID 3.39 kW" when the frame carries no slot figures.',
  },
  {
    id: 'M-ii. ★★ the main is drawn without the Cores’ own draw taken out',
    file: MODEL,
    find: "    gridToHouseW = gridState !== 'active' ? 0 : coresSeenIdle ? load : Math.min(load, Math.max(0, homeGridW - coresAcIn));",
    to: "    gridToHouseW = gridState !== 'active' ? 0 : coresSeenIdle ? load : Math.min(load, homeGridW); /* MUTANT */",
    why: 'A Core’s 2 kW charge through the main is drawn a second time, as the house on the grid.',
  },
  {
    id: 'B-i. ★★★ a frame behind the Cores’ own meters is never detected',
    file: MODEL,
    find: '  const viaFlow = viaPanel.filter((x) => !behindPanels.has(x.p));',
    to: '  const viaFlow = viaPanel; /* MUTANT */',
    why: 'At the 09-21 hand-over a dark Core’s stale −1713 W puts the grid on standby and draws a 5137 W Batteries → Loads edge.',
  },
  {
    id: 'B-ii. ★★ the meters’ tolerance loses its 150 W floor',
    file: MODEL,
    find: '    return Math.abs(w - own) > Math.max(FRAME_LAG_MIN_W, FRAME_LAG_FRACTION * Math.max(Math.abs(w), Math.abs(own)));',
    to: '    return Math.abs(w - own) > FRAME_LAG_FRACTION * Math.max(Math.abs(w), Math.abs(own)); /* MUTANT */',
    why: 'An idle Core’s 100 W metering offset marks a current frame behind, and the dark Core’s delivery is drawn as grid import.',
  },
  {
    id: 'B-iii. ★★ the meters’ tolerance loses its 20 % share',
    file: MODEL,
    find: '    return Math.abs(w - own) > Math.max(FRAME_LAG_MIN_W, FRAME_LAG_FRACTION * Math.max(Math.abs(w), Math.abs(own)));',
    to: '    return Math.abs(w - own) > FRAME_LAG_MIN_W; /* MUTANT */',
    why: '300 W of disagreement in a steady 5.3 kW charge drops the dark Core’s charge from the grid → Batteries edge.',
  },
  {
    id: 'B-iv. ★★ a reporting Core’s own exchange is read with the wrong sign',
    file: MODEL,
    find: '    const own = (d.projection.acInWatts ?? 0) - (d.projection.acOutWatts ?? 0);',
    to: '    const own = (d.projection.acOutWatts ?? 0) - (d.projection.acInWatts ?? 0); /* MUTANT */',
    why: 'Every steady charge reads as a frame behind, and the dark Cores’ charge is never drawn.',
  },
  {
    id: 'B-v. ★★ one panel’s frame behind drops every panel’s dark slots',
    file: MODEL,
    find: '  const viaFlow = viaPanel.filter((x) => !behindPanels.has(x.p));',
    to: '  const viaFlow = behindPanels.size > 0 ? [] : viaPanel; /* MUTANT */',
    why: 'A second panel’s current 3 kW charge disappears because the house panel’s frame is behind.',
  },
  {
    id: 'B-vi. ★★ a behind frame’s dark slots still count as the Cores’ grid draw',
    file: MODEL,
    find: '  const acIn = ownAcIn + viaFlow.reduce((t, x) => t + Math.max(0, x.w), 0);',
    to: '  const acIn = ownAcIn + viaPanel.reduce((t, x) => t + Math.max(0, x.w), 0); /* MUTANT */',
    why: 'At the 09-22 charge end a dark Core’s stale +5.3 kW is drawn as grid → Batteries after the charge ended.',
  },
  {
    id: 'B-vii. ★★ a frozen Core’s meter judges the frame',
    file: MODEL,
    find: '  const ownBySn = new Map(metered.map((d) => [d.sn, d]));',
    to: '  const ownBySn = new Map(dpus.map((d) => [d.sn, d])); /* MUTANT */',
    why: 'Three Cores frozen at 0 W mark a live frame behind, and the 20:04 house is drawn with nothing feeding it.',
  },
  {
    id: 'F-vii. ★★★ a frozen Core’s own AC input is counted as the Cores’ grid draw',
    file: MODEL,
    find: '  const gridDpus = sourceSns.size > 0 ? metered.filter((d) => sourceSns.has(d.sn)) : metered;',
    to: '  const gridDpus = sourceSns.size > 0 ? dpus.filter((d) => sourceSns.has(d.sn)) : dpus; /* MUTANT */',
    why: 'Cores frozen mid-charge keep a 15.9 kW grid → Batteries edge on screen after the charge ended, or count a live charge twice.',
  },
  {
    id: 'T-xii. ★★★ a disconnected slot’s Core bounds the pool',
    file: MEMB,
    find: '      if (!src.isConnected || !src.sn || chosen.has(src.sn)) return;',
    to: '      if (!src.sn || chosen.has(src.sn)) return; /* MUTANT */',
    why: 'A bench spare charging from the wall publishes a time to full and hides the time to reserve during a 2 kW drain.',
  },
  {
    id: 'T-xiii. ★ a Core listed by two panels is counted twice',
    file: MEMB,
    find: '  const listings = connectedSourceListings(devices, nowMs);\n  // v1.188.1 (review) — with the bridge',
    to: '  const listings = allShp2s(devices).flatMap((panel) => (panel.projection.sources ?? []).map((src, index) => ({ panel, src, index }))).filter((l) => l.src.isConnected && !!l.src.sn); /* MUTANT */\n  // v1.188.1 (review) — with the bridge',
    why: 'One Core’s exchange is added once per panel that lists it.',
  },
  {
    id: 'T-xiv. ★★ the bound reads the poll’s pack flow, not the stream’s',
    file: MEMB,
    find: '      for (const pk of d.projection.packs ?? []) { const f = pk.liveFlow ?? pk; watts +=',
    to: '      for (const pk of d.projection.packs ?? []) { const f = pk; /* MUTANT */ watts +=',
    why: 'The poll’s replayed 3 kW charge outweighs the stream’s 2 kW discharge: a time to full during a drain (v1.186.2).',
  },
  {
    id: 'T-xv. ★★★ an offline Core with a recent projection is read on its own meter',
    file: MEMB,
    find: '    return verdicts ? verdicts.own.has(sn) : d.online === true && dpuContentFresh(d, nowMs);',
    to: '    return verdicts ? verdicts.own.has(sn) : dpuContentFresh(d, nowMs); /* MUTANT */',
    why: 'The packs’ last charge, carried across the offline flip, publishes a time to full while the slots deliver 3 kW.',
  },
  // ── review round 2 recheck: the house shared while a Core's delivery is unmeasured ──────────
  {
    id: 'U-i. ★★★ the grid takes the rest of the house with a Core unmeasured',
    file: MODEL,
    find: '    gridToHouseW = coresShareUnmeasured ? Math.min(rest, Math.max(0, homeGridW - coresAcIn)) : rest;',
    to: '    gridToHouseW = rest; /* MUTANT */',
    why: 'One Core at 1145 W, two dark with no figure, main 500 W: 2245 W of grid → Loads nothing measured.',
  },
  {
    id: 'U-ii. ★★ a dark Core on a behind frame counts as measured',
    file: MODEL,
    find: '  const coresShareUnmeasured = unmeteredCores > 0 || viaFlow.length < viaPanel.length;',
    to: '  const coresShareUnmeasured = unmeteredCores > 0; /* MUTANT */',
    why: 'The dark Core’s stale share goes to the grid: 1400 W of grid → Loads against a 400 W main.',
  },
  {
    id: 'U-iii. ★★ a Core with no figure from either meter counts as measured',
    file: MODEL,
    find: '  const coresShareUnmeasured = unmeteredCores > 0 || viaFlow.length < viaPanel.length;',
    to: '  const coresShareUnmeasured = viaFlow.length < viaPanel.length; /* MUTANT */',
    why: 'Two Cores with no figure have their share drawn as grid import.',
  },
  {
    id: 'U-iv. ★★ the capped grid edge keeps the Cores’ own draw',
    file: MODEL,
    find: '    gridToHouseW = coresShareUnmeasured ? Math.min(rest, Math.max(0, homeGridW - coresAcIn)) : rest;',
    to: '    gridToHouseW = coresShareUnmeasured ? Math.min(rest, homeGridW) : rest; /* MUTANT */',
    why: 'A dark Core’s 2 kW charge through the main is drawn a second time, as the house on the grid.',
  },
  {
    id: 'T-xvi. ★★ the bound leaves out each dark Core\'s own draw',
    file: MEMB,
    find: "    watts += shp2ReadbackFresh(p, nowMs) && typeof w === 'number' && Number.isFinite(w) ? -w - pv + SLOT_UNMETERED_DRAW_W : Infinity;",
    to: "    watts += shp2ReadbackFresh(p, nowMs) && typeof w === 'number' && Number.isFinite(w) ? -w - pv : Infinity; /* MUTANT */",
    why: 'The review defect: at the reserve hold the slots read about 0 W while the packs supply the Cores\' standby, and the time to full is published; 30 W of standby intake reads as a proven charge and hides the time to empty.',
  },
  {
    id: 'V-i. ★★★ the console reads the Cores-only sums again',
    file: TYPES,
    find: '  return { fleetPv: b.fleetPv, fleetBatteryNet: b.fleetBatteryNet, verdicts: slotVerdicts(b) };',
    to: '  return { fleetPv, fleetBatteryNet, verdicts: slotVerdicts(b) }; /* MUTANT */',
    why: 'The review defect: with every Core cloud-offline the console reads "BATT.P.NET 0 W IDLE" and "BATT idle" beside a 3.4 kW drain the HA sensors publish.',
  },
  {
    id: 'V-ii. ★★ the console\'s BATT.P.NET reads IDLE while the sensors are unknown',
    file: CONSOLE,
    find: "      flags: batNet == null ? '—' : batNet > 5 ? 'DCH' : batNet < -5 ? 'CHG' : 'IDLE',",
    to: "      flags: batNet == null ? 'IDLE' : batNet > 5 ? 'DCH' : batNet < -5 ? 'CHG' : 'IDLE', /* MUTANT */",
    why: 'An unknown battery net reads as an idle pool.',
  },
  {
    id: 'V-iii. ★★ the console\'s mimic draws the battery idle while the sensors are unknown',
    file: CONSOLE,
    find: "    (batNet == null ? c.grey('—') : batNet > 5 ? c.yellow('▼ DCH') : batNet < -5 ? c.green('▲ CHG') : c.grey('idle'));",
    to: "    (batNet == null ? c.grey('idle') : batNet > 5 ? c.yellow('▼ DCH') : batNet < -5 ? c.green('▲ CHG') : c.grey('idle')); /* MUTANT */",
    why: 'An unknown battery net is drawn as an idle pool beside the house load.',
  },
  // ── review round 3 ────────────────────────────────────────────────────────
  {
    id: 'W-i. ★★★ the at-floor guard counts a frozen-online Core as reporting again',
    file: GRID,
    find: '  const poolCoverage = homeCoreCoverage(input.devices, undefined, nowMs);',
    to: '  const poolCoverage = homeCoreCoverage(input.devices); /* MUTANT */',
    why: 'The review defect: at the floor with gridSta = Grid OK and a frozen Core\'s held 0 W, the guard backstops and the critical SoC-ladder and runway alarms drop to a low advisory while the slot delivers 1.1 kW.',
  },
  {
    id: 'W-ii. ★★ coverage with a clock ignores the content clock',
    file: MEMB,
    find: '  const online = new Set(onlineDpus(devices).filter((d) => nowMs == null || dpuContentFresh(d, nowMs)).map((d) => d.sn));',
    to: '  const online = new Set(onlineDpus(devices).map((d) => d.sn)); /* MUTANT */',
    why: 'The guard is passed a clock and still counts the frozen Core.',
  },
  {
    id: 'W-iii. ★★★ the bound takes no PV out of a slot the bridge reads as measured',
    file: MEMB,
    find: '    const pv = verdicts?.measuredPvW.get(slotKey(p.sn, s.slot)) ?? 0;',
    to: '    const pv = 0; /* MUTANT */',
    why: 'The review defect: by day with a trusted PV field the time to empty is published and the time to full withheld beside a Battery Net charging 4.5 kW.',
  },
  {
    id: 'W-iv. ★★★ the bound\'s own-meter test ignores the bridge\'s verdict',
    file: MEMB,
    find: '    return verdicts ? verdicts.own.has(sn) : d.online === true && dpuContentFresh(d, nowMs);',
    to: '    return d.online === true && dpuContentFresh(d, nowMs); /* MUTANT */',
    why: 'The review defect: a Core the cloud lists offline whose MQTT data still arrives is read from its slot (+1.8 kW) while the sensors publish its own 4.5 kW charge.',
  },
  {
    id: 'W-v. ★★ the \'cores\' basis ignores the verdict',
    file: MEMB,
    find: '  if (homeCoreCoverage(devices).complete && !frozen && (!verdicts || listings.every((l) => verdicts.own.has(l.src.sn as string)))) {',
    to: '  if (homeCoreCoverage(devices).complete && !frozen) { /* MUTANT */',
    why: 'A marked Core the bridge still meters at its slot has its held 3 kW charge summed: a time to full while its slot delivers 1.5 kW.',
  },
  {
    id: 'W-vi. ★★ /api/ha-state\'s timers ignore the verdicts',
    file: IDX,
    find: '  const timers = backupTimerGate(snap.devices, Date.now(), slotVerdicts(bridged));',
    to: '  const timers = backupTimerGate(snap.devices, Date.now()); /* MUTANT */',
    why: 'The shared gate is fixed and the REST sensors never pass the verdicts to it.',
  },
  {
    id: 'W-vii. ★★★ the console\'s RUN line ignores the verdicts',
    file: CONSOLE,
    find: '    const timers = backupTimerGate(data.snap.devices, Date.now(), data.flow?.verdicts);',
    to: '    const timers = backupTimerGate(data.snap.devices, Date.now()); /* MUTANT */',
    why: 'The review defect: "BATT.P.NET 4.50 kW CHG" beside "RUN ▼ DCH 18h 20m ▲ CHG —" on one screen.',
  },
  {
    id: 'W-viii. ★★ the console\'s flow carries no verdicts',
    file: TYPES,
    find: '  return { fleetPv: b.fleetPv, fleetBatteryNet: b.fleetBatteryNet, verdicts: slotVerdicts(b) };',
    to: '  return { fleetPv: b.fleetPv, fleetBatteryNet: b.fleetBatteryNet }; /* MUTANT */',
    why: 'The RUN line reads the verdicts from the flow, and the flow never carries them.',
  },
  {
    id: 'W-ix. ★★★ panelForClient drops the bridge\'s verdicts',
    file: MEMB,
    find: '        ...(verdicts && src.isConnected && src.sn ? {',
    to: '        ...((false as boolean) && verdicts && src.isConnected && src.sn ? { /* MUTANT */',
    why: 'The card never sees ownReading or pvMeasuredW: "Cores not reporting" beside a Fleet PV of 6 kW.',
  },
  {
    id: 'W-x. ★★ snapshotForClient sends the house panel without the verdicts',
    file: IDX,
    find: '      ? { ...panelForClient(shp2, s.devices, nowMs, verdicts), grid, off_grid }',
    to: '      ? { ...panelForClient(shp2, s.devices, nowMs), grid, off_grid } /* MUTANT */',
    why: 'The helper is tested and the production path skips the verdicts for the house panel.',
  },
  {
    id: 'W-xi. ★★★ the card ignores the ownReading verdict',
    file: MODEL,
    find: "  const verdictSent = connectedSlots.length > 0 && connectedSlots.every((s) => typeof s.ownReading === 'boolean');",
    to: '  const verdictSent = false; /* MUTANT */',
    why: 'The review defect: three Cores listed offline streaming their own data are drawn "via panel", "▼ 1.50 kW out", Solar "—", while the sensors count them at their own 6 kW of PV.',
  },
  {
    id: 'W-xii. ★★★ the card ignores a slot\'s measured PV',
    file: MODEL,
    find: '  const slotPv = viaPv.reduce((t, x) => t + (measuredPv(x) as number), 0);',
    to: '  const slotPv = 0; /* MUTANT */',
    why: 'The review defect: Solar "—" and "▼ 1.50 kW out" beside a Fleet PV of 6 kW and a Battery Net charging 4.5 kW.',
  },
  {
    id: 'W-xiii. ★★ the Solar node stays "—" with only measured slot PV',
    file: MODEL,
    find: '  const pv: number | null = ownMeter.size === 0 && viaPv.length === 0 && silentSlots.length > 0 ? null : ownPv + slotPv;',
    to: '  const pv: number | null = ownMeter.size === 0 && silentSlots.length > 0 ? null : ownPv + slotPv; /* MUTANT */',
    why: 'Every Core dark: the measured slot PV is computed and the Solar node reads "Cores not reporting".',
  },
  {
    id: 'W-xiv. ★★ pvUnreported counts the measured slots',
    file: MODEL,
    find: '    pvUnreported: silentSlots.length - viaPv.length,',
    to: '    pvUnreported: silentSlots.length, /* MUTANT */',
    why: 'Solar reads "0 of 3 Cores" beside the 6 kW it covers.',
  },
  {
    id: 'W-xv. ★★ the Solar subtitle leaves out the measured slots',
    file: MODEL,
    find: '  const covered = m.dpuCount + (m.pvViaPanel ?? 0);',
    to: '  const covered = m.dpuCount; /* MUTANT */',
    why: 'One measured slot of three reads "0 of 2 Cores".',
  },
  {
    id: 'W-xvi. ★ the card passes no pvViaPanel to the Solar subtitle',
    file: CARD,
    find: 'subtitle={solarSubtitle({ pv, dpuCount, pvUnreported, pvViaPanel })}',
    to: 'subtitle={solarSubtitle({ pv, dpuCount, pvUnreported })} /* MUTANT */',
    why: 'The model counts the measured slots and the card drops them from the subtitle.',
  },
  {
    id: 'W-xvii. ★★★ a measured slot\'s pack net keeps its PV in',
    file: MODEL,
    find: '  const batNet = ownBatNet - viaFlow.reduce((t, x) => t + x.w, 0) - slotPv;',
    to: '  const batNet = ownBatNet - viaFlow.reduce((t, x) => t + x.w, 0); /* MUTANT */',
    why: 'Solar shows the 6 kW and the Batteries box still reads it as "1.50 kW out": the PV counted twice.',
  },
  {
    id: 'W-xviii. ★ the subtitle reads "in" / "out" with every via-panel slot measured',
    file: MODEL,
    find: '  const acExchange = m.viaPanelCount > (m.pvViaPanel ?? 0);',
    to: '  const acExchange = m.viaPanelCount > 0; /* MUTANT */',
    why: 'The packs\' own net reads "in" beside a Battery Net that says charging.',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs).
// fullSuite: false — the subset holds every test that guards these mutants, so a kill comes
// from the subset.
import { runMutantsParallel } from './lib/mutateParallel.mjs';
// typecheck: true — a mutant that does not compile is reported INVALID, never counted as a kill.
await runMutantsParallel({ name: 'mutate-energyflow-offline', mutants: MUTANTS, subset: SUBSET, root: REPO, fullSuite: false, typecheck: true });
