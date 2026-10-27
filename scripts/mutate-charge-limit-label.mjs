#!/usr/bin/env node
/**
 * mutate-charge-limit-label.mjs — committed harness for v1.190.1: the Smart Home Panel card's
 * charge limit (per battery, with the connected fleet's envelope) and its backup timers (on the
 * server's backupTimerGate verdict, the gate the HA sensors use).
 *
 * WHY COMMITTED: `chargeWattPower` is the panel's configured AC charge-rate limit for EACH
 * connected battery (7,200 W; measured 2026-10-13/14: three Cores took 18.1 kW together, the main
 * 19,253 W). The card read it as "Charge power 7.20 kW", the rate the whole pool charges at, and
 * gated its "Charge time" on it, a limit that says nothing about direction, so it showed "38 min"
 * to full while the pool drained 3.4 kW through the panel. Each regression below renders a
 * confident, plausible figure; none fails a build.
 *
 *   node scripts/mutate-charge-limit-label.mjs
 *
 * ★ Anchor-asserted; a red subset baseline aborts; each mutant runs in its own copy of the tree
 *   (scripts/lib/mutateParallel.mjs), so the working tree is never written.
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = resolve(REPO, 'server');
const TEXT = resolve(REPO, 'web/src/cards/shp2ChargeText.ts');
const CARD = resolve(REPO, 'web/src/cards/Shp2Card.tsx');
const MEM = resolve(SERVER, 'src/shp2Membership.ts');

const SUBSET = ['test/shp2ChargeLabel.test.ts'];

const MUTANTS = [
  {
    id: 'i. ★★★ the envelope ignores the connected count: 7.2 kW × 3 reads 7.20 kW',
    file: TEXT,
    find: '  const envelope = known && slots > 0 ? `× ${slots} connected = ${fmtW(limitW * slots)}` : null;',
    to: '  const envelope = known && slots > 0 ? `× ${slots} connected = ${fmtW(limitW)}` : null; /* MUTANT */',
    why: 'The per-battery limit is presented as the fleet’s, the misreading this release corrects.',
  },
  {
    id: 'ii. ★★ the label reverts to "Charge power"',
    file: TEXT,
    find: "export const CHARGE_LIMIT_LABEL = 'Charge limit (per battery)';",
    to: "export const CHARGE_LIMIT_LABEL = 'Charge power'; /* MUTANT */",
    why: 'A configured limit reads as a live power again.',
  },
  {
    id: 'iii. ★★★ backupTimerText ignores the verdict',
    file: TEXT,
    find: "  return applicable === true ? fmtMins(minutes) : '—';",
    to: '  return fmtMins(minutes); /* MUTANT */',
    why: 'The panel’s charge timer shows during a drain ("38 min" to full while the pool fell 3.4 kW).',
  },
  {
    id: 'iv. ★★ connectedSlotCount counts every slot',
    file: TEXT,
    find: '  for (const s of sources ?? []) if (s.isConnected && s.sn) n++;',
    to: '  for (const s of sources ?? []) n++; /* MUTANT */',
    why: 'A panel with one Core out for a pack swap still shows a three-battery envelope.',
  },
  {
    id: 'v. ★★ no envelope guard: zero connected slots render "× 0 connected = 0 W"',
    file: TEXT,
    find: '  const envelope = known && slots > 0 ?',
    to: '  const envelope = known ? /* MUTANT */',
    why: 'A panel whose sources subtree a partial quota omitted shows an envelope of 0 W.',
  },
  {
    id: 'vi. ★★★ the card gates the charge timer on chargeWattPower again',
    file: CARD,
    find: 'backupTimerText(p.backupChargeTimeMin, d.backupTimers?.charge)',
    to: 'backupTimerText(p.backupChargeTimeMin, (p.chargeWattPower ?? 0) > 50) /* MUTANT */',
    why: 'The v1.188.1 review’s "38 m during a drain" comes back: a limit is not a direction.',
  },
  {
    id: 'vii. ★★★ panelForClient sends both timers as applicable',
    file: MEM,
    find: '    backupTimers: (({ charge, discharge }) => ({ charge, discharge }))(backupTimerGate(devices, nowMs, verdicts)),',
    to: '    backupTimers: { charge: true, discharge: true }, /* MUTANT */',
    why: 'The card and /api/ha-state disagree: the sensor withholds the charge timer during a drain, the card shows it.',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs);
// the verdict procedure per mutant (subset, then the full suite on a subset pass) is unchanged.
import { runMutantsParallel } from './lib/mutateParallel.mjs';
await runMutantsParallel({ name: 'mutate-charge-limit-label', mutants: MUTANTS, subset: SUBSET, root: REPO });
