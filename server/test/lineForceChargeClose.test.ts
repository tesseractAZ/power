import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as nfc from '../src/nightForceCharge.js';
import { decideForceCharge, forceChargeRateKw, evDisplacedPackKwh, type ForceChargeOpts } from '../src/nightForceCharge.js';
import { emptyActuationState, type NightActuationState } from '../src/nightChargeActuator.js';
import { buildNightChargeMorningSummary } from '../src/notify.js';

/**
 * v1.200.0 — THE CLOSE GUARANTEE OF THE LINE FORCE-CHARGE (plan §5.4 T7).
 *
 * A charge night whose outage line L is above the panel's 50% reserve is carried by the night
 * force-charge in LINE mode: the reserve leg takes the pool to 50% and holds the house on the grid; the
 * force-charge starts timed to reach ⌈L⌉ + 5 twenty minutes before the window close, has no software
 * stop, and stays ON to the close; the panel ceiling is at least ⌈L⌉ + 10. While Charge Now is ON under
 * the ceiling the house (and an EV) ride the grid, so a load that starts late cannot draw the pool down.
 *
 * The plant (the integrator's rtcSim, run minute by minute around the REAL decideForceCharge):
 *  - 92.16 kWh nameplate × 0.944 measured: the pool percent is a share of 86.999 kWh; the tick times its
 *    start on the panel's nameplate backupFullCapWh (92.16), as index.ts passes it;
 *  - ON and under the panel ceiling: the pack gains (17 − house − EV) × 0.927 × k per hour (the grid
 *    cap less the load, through the charge leg; k the share of that rate the pack actually takes);
 *  - AT THE CEILING THE PANEL SWITCHES THE SLOTS' CHARGE NOW OFF AND LEAVES THEM OFF (read with the
 *    panel-side classifier on 2026-09-23 — ch1 off at 04:19, ch3 at 04:30 — and 2026-10-02, slots 2 and 1 at
 *    04:24-04:25; 2026-09-18's 90 → 86% after the ceiling is consistent with it, but that night's slot state is
 *    the add-on's record, not a readback). The plant once resumed importing below the ceiling, which no Core
 *    does. Then, or OFF, the house draws the pack (load ÷ 0.94 + the Cores' standby), held at the 50% reserve; the slots read OFF
 *    until an ON of ours (the tick's 'on', 'onRetry' or 'lineReOn') takes effect;
 *  - the tick's evDisplacedKwh is the plan's predicted (P90) window EV, constant through the night, through
 *    evDisplacedPackKwh, exactly as index.ts passes it — so a predicted EV pulls the start early;
 *  - the panel's ceiling reads back the minute after a sync; an ON takes effect after `onDelayMin`;
 *    readings are whole percents (rounded, or floored), `staleMin` old; each slot's Core reads the pool;
 *  - the close is the median of the last 15 minutes' readings (the scorer's window_close_soc_pct), and a
 *    night is UNDER when it closes below L − 0.05 (REALIZED_CLOSE_TOLERANCE_PCT).
 *
 * Year-shaped lines (the legacyIdentity year's qualifying lines, 50.45-65.95), houses 0.6-3.6 kW, rate
 * factors 0.9-1.25: 0 nights under in every STRESS cell and every PREDICTED-EV cell (the MEASURED, OFF-reading
 * latch, then the tick's line re-ON, lineReOnDue). What the line force-charge cannot carry is pinned exactly, not claimed:
 *  - asks of 70-90 with a slow pack (the window cannot deliver a 20-40 point lift);
 *  - a late UNPREDICTED load that takes the grid cap after the start (an 11.52 kW EV — EV_MAX_LOAD_W, the
 *    site's 48 A × 240 V default — or a 7 kW one two hours out), alone or with another stress: the start
 *    was timed on a rate the pack then does not get;
 *  - a COST-DOMINANT night (the cost stop already at ⌈L⌉ + 10 or above: today's cost force-charge exactly,
 *    with its software stop) whose late EV draws the pool back under the line after that stop.
 * (review 2) THE ON-READING LATCH — a slot that keeps reading ON at its ceiling and stops importing — is UNMEASURED on
 * this plant (variant 'onLatch'): nothing of ours switches it back on, so predicted-EV nights close under the line there
 * (pinned exactly, PIN_ON_LATCH); the line-at-risk push (lineAtRiskPushDue) reaches every one of them at least 20 min
 * before the close. The plant stamps the night's observations and asks for the push on each tick, as index.ts does.
 * (review 3) …and logs the ON-reading shape as index.ts does: never on the measured latch (the re-ON working is not the
 * unmeasured one), on every onLatch night that closes under. The push comes after the latch on all but one of those
 * nights (PIN_ON_LATCH_PUSHED_BEFORE_LATCH), and on the measured latch it goes on 2 (5 floored) of 3,740 nights that hold.
 * (review 4) A RE-ON THE CLOUD ACCEPTS THAT NEVER TAKES EFFECT — also UNMEASURED (variant 'reOnInert'): the re-ON's check
 * finds it not applied, and the push reaches 174 of the 390 year nights that close under and 2,335 of 2,615 at lines of
 * 70-90% (PIN_REON_INERT); (Fix8 review 1) judged on the check's own tick too, as index.ts judges it. Of the rest, 471 have their
 * last check at or inside the push's lead; 25 have it on the last tick before the re-ON's cutoff with a re-ON left, which holds the
 * push and then meets the cutoff (PIN_REON_INERT_UNREACHED). The plant stamps each check through index.ts's own pure stamp
 * (lineReOnCheckedStamp).
 * (review 5) AN ON NO WRITE OF OURS EXPLAINS IN TIME — a re-ON applied a minute after its check ('reOnLate'), one all-OFF
 * reading at the check ('reOnGlitch'), Charge Now switched on by a person after the push ('reOnPerson') — is waited out
 * (lineNightObservations stamps it, lineTrendReference waits): the ON-reading shape is never logged on any of them. And a
 * re-ON handed back rate-limited ('reOnLimited') is never pushed as the gates inside its retry's spacing (PIN_REVIEW5).
 * (review 6) …nor lost: with the ticks off the minute (`phaseMs`) and every re-ON stamped after its writes (`lagMs`, as
 * index.ts stamps Date.now()), each hand-back with a tick left before the push's lead gets its retry or the push, never
 * neither (PIN_REVIEW6). And a person's ON followed by the panel's stop at its ceiling ('reOnPerson') is stamped as a stop,
 * and the morning names it. (review 8) The push is judged on the hand-back's own tick too (index.ts), so one on the last tick
 * before the cutoff is pushed there; the hold keeps a full tick of margin, so a push may be followed by the retry (counted);
 * and no night without a hand-back changes (PIN_REVIEW8_IDENTITY). (Fix8 review 1) The push and the shape log are judged on every
 * tick kind index.ts judges them on (judgeLineNight: a tick that decides nothing, the lowering, the hand-back, the re-ON's check),
 * each once a night on the record.
 * Three discriminators show the grid can see the mutants it is meant to kill: a software stop at ⌈L⌉ (design
 * A's hold, F-i), a start timed to ⌈L⌉ without the + 5 (F-iii), and no re-ON after the latch.
 * (A5, T18) A LINE WITHIN 10 POINTS OF FULL is armed and runs as a 90% line (start 95, ceiling 100): its nights under the
 * line, the push on them, ≤ 3 ON-kind writes a night, the ON minutes, and the lines a full pool cannot hold, pinned on the
 * measured latch and on the ON-reading one; the panel's own stop at 100% is unmeasured.
 */

const MIN = 60_000;
const H = 3_600_000;
const NAME = 92.16;
const CAP = NAME * 0.944;
const LEG = 0.927;
const DIS = 0.94;
const W0 = Date.UTC(2027, 0, 5, 6);
const W1 = W0 + 6 * H;
/** EV_MAX_LOAD_W at its default (config.ts; analytics.ts "48 A × 240 V"), kW. */
const EV_MAX_KW = 11.52;

/** 'onLatch' (review 2) — the ON-READING latch, UNMEASURED on this plant: at the ceiling a slot stops importing but
 *  keeps reading Charge Now ON, and imports again only once an ON of ours takes effect (none comes: the re-ON keys
 *  on slots reading OFF). 'reOnInert' (review 4) — the latch as measured (the slots read OFF), but a line re-ON the
 *  cloud accepts never takes effect: its slots still read OFF at its readback check (lineReOnCheckDue), a failure
 *  path the add-on is built to handle (its own check, its own push cause), never measured here. (review 5) 'reOnLate' —
 *  a line re-ON that takes effect 16 min after its write, a minute after its readback check found it not applied (an ON
 *  readback lagged 14 min on 2026-10-06); 'reOnGlitch' — a re-ON that takes effect, but the readback on its check's tick
 *  alone shows every slot OFF; 'reOnPerson' — 'reOnInert' with a person who follows the push: Charge Now switched on in
 *  the app 5 min after a push that names slots reading OFF; 'reOnLimited' — the night's first line re-ON comes back
 *  rate-limited on every write and is handed back (index.ts: the count returned, no slots), its retry 15 min later. */
type Variant = 'real' | 'hold' | 'askStart' | 'noReOn' | 'onLatch' | 'reOnInert' | 'reOnLate' | 'reOnGlitch' | 'reOnPerson' | 'reOnLimited';
interface Knobs {
  p0: number; evFromMin: number | null; evKw: number; standbyKw: number; onDelayMin: number; staleMin: number; floor: boolean;
  /** The plan's predicted window EV (kWh) the tick passes as evDisplacedKwh; 'exact' = the EV that comes. */
  predEvKwh: number | 'exact' | null;
  /** The record's cost ceiling, with the cost gate on (null: the cost gate off, a resilience-objective night). */
  costPct: number | ((ask: number) => number) | null;
  /** (review 6) The ticks' phase against the minute (the close, W1, stays on it), and how long after its tick a re-ON is
   *  stamped (index.ts stamps forceChargeLineReOnAtMs: Date.now() after the writes), ms. */
  phaseMs: number; lagMs: number;
  /** (Fix8 review 1) Whether the re-ON's readback check's own tick is judged for the push and the shape log, as index.ts judges it
   *  now; false is the emulation before (the identity pins of earlier rounds). */
  judgeCheck: boolean;
}
const BASE: Knobs = { p0: 50, evFromMin: null, evKw: 7, standbyKw: 0, onDelayMin: 0, staleMin: 0, floor: false, predEvKwh: null, costPct: null, phaseMs: 0, lagMs: 0, judgeCheck: true };

type LineState = NightActuationState & {
  forceChargeLineAskPct: number | null; forceChargeLinePct: number | null; forceChargeCeilingSyncedPct: number | null;
  forceChargeMode: 'cost' | 'line' | null;
};

/** (review 3) `shapeAtMs` — the tick the once-a-night ON-reading-shape log fires (index.ts: on a tick that decides
 *  nothing; Fix8 review 1: on every tick judgeLineNight judges); `lossAtMs` — 'onLatch' only: the minute the slots stopped importing while reading ON (the event that loses
 *  the line there); `pushCause` — the line-at-risk push's cause. (review 4) `reOnsFailed` — re-ONs whose readback check
 *  found every slot not applied. (review 6) `handBackAtMs` / `retryAtMs` — 'reOnLimited': the hand-back's tick and its
 *  retry's; `personOnAtMs` / `personStopAtMs` — 'reOnPerson': the person's ON taking effect, and the panel's stop at its
 *  ceiling after it; `panelOffAtMs` — the panel's stop on the record at the close; `stopNamed` — the morning account (the
 *  real builders, the record closed by the window) names the panel's stop as what ended the charge. (review 8)
 *  `pushRetryPossible` — the push's reOnRetryPossible (its 'reOnRefused' words: "it may try once more", or not). */
function night(L: number, houseKw: number, k: number, kn: Knobs, variant: Variant): {
  close: number; onMin: number; reOns: number; reOnsFailed: number; pushedAtMs: number | null; shapeAtMs: number | null; lossAtMs: number | null; pushCause: string | null;
  pushRetryPossible: boolean; lastCheckAtMs: number | null; reOnsAtLastCheck: number;
  handBackAtMs: number | null; retryAtMs: number | null; personOnAtMs: number | null; personStopAtMs: number | null; panelOffAtMs: number | null; stopNamed: boolean;
  onWrites: number;
} {
  // (A5) The record's ask is ⌈L⌉ at most 100 (askOf, coerceLineAskPct): a line above a full pool asks 100.
  const ask = Math.min(100, Math.ceil(L - 1e-9));
  const cost = typeof kn.costPct === 'function' ? Math.min(100, kn.costPct(ask)) : kn.costPct;
  let s: LineState = {
    ...emptyActuationState(),
    day: '2027-01-04', targetPct: 50, buyKwh: 20, windowStartMs: W0, windowEndMs: W1,
    applyAttemptedAtMs: W0 - 5 * MIN, attemptBaselinePct: 30, appliedAtMs: W0 - 5 * MIN, priorReservePct: 30,
    applyVerifiedAtMs: W0 - MIN, forceChargeCeilingPct: cost, forceChargeRides: true,
    forceChargeLineAskPct: ask, forceChargeLinePct: L, forceChargeCeilingSyncedPct: null, forceChargeMode: null,
  } as LineState;
  const gates = { cost: cost != null, line: true };
  let pack = (kn.p0 / 100) * CAP;
  let panelCeiling = 100;
  let pendingCeiling: number | null = null;
  let onEffectiveMs: number | null = null;
  let chargeNowOn = false;
  let importing = true;
  let pushedAtMs: number | null = null;
  let pushCause: string | null = null;
  let pushRetryPossible = false;
  let shapeAtMs: number | null = null;
  let lossAtMs: number | null = null;
  let onMin = 0;
  let reOns = 0;
  let reOnsFailed = 0;
  /** (Fix8 review 1) The last re-ON check's tick, and the re-ONs spent when it ran. */
  let lastCheckAtMs: number | null = null;
  let reOnsAtLastCheck = 0;
  /** (A5) ON-kind writes the night made: the ON, its retry, the line re-ONs (a handed-back one wrote nothing). */
  let onWrites = 0;
  let handedBack = false;
  let handBackAtMs: number | null = null;
  let retryAtMs: number | null = null;
  let personPending = false;
  let personOnAtMs: number | null = null;
  let personStopAtMs: number | null = null;
  const readings: number[] = [];
  const tail: number[] = [];
  const evKwh = kn.evFromMin != null ? kn.evKw * Math.min(kn.evFromMin, (W1 - W0) / MIN) / 60 : 0;
  const pred = kn.predEvKwh === 'exact' ? evKwh : kn.predEvKwh;
  for (let t = W0 + kn.phaseMs; t < W1; t += MIN) {
    if (pendingCeiling != null) { panelCeiling = pendingCeiling; pendingCeiling = null; }
    const raw = (pack / CAP) * 100;
    const now = kn.floor ? Math.floor(raw) : Math.round(raw);
    readings.push(now);
    const seen = readings[Math.max(0, readings.length - 1 - kn.staleMin)];
    if (t >= W1 - 15 * MIN) tail.push(now);
    const ev = kn.evFromMin != null && t >= W1 - kn.evFromMin * MIN ? kn.evKw : 0;
    const load = houseKw + ev;
    const chargeRateKw = forceChargeRateKw({ gridCapKw: 17, houseLoadKw: load, legEff: LEG, slotCount: 3 });
    // index.ts: the plan's P90 window EV, through evDisplacedPackKwh, on every tick of this window.
    const evDisplacedKwh = pred != null && pred > 0
      ? evDisplacedPackKwh({ evKwh: pred, peakEvKw: kn.evKw, rateKw: chargeRateKw, unboundedRateKw: Math.max(1, (17 - load) * LEG), legEff: LEG })
      : null;
    if (onEffectiveMs != null && t >= onEffectiveMs) {
      chargeNowOn = true; importing = true; onEffectiveMs = null;
      if (personPending) { personPending = false; personOnAtMs = t; }
    }
    // (review 5) 'reOnGlitch': the readback on the re-ON check's tick alone shows every slot OFF.
    const glitch = variant === 'reOnGlitch' && s.forceChargeLineReOnSlots != null && s.forceChargeLineReOnAtMs != null
      && t === s.forceChargeLineReOnAtMs + nfc.FORCE_CHARGE_ON_VERIFY_AFTER_MS;
    const o = {
      enabled: gates.cost, lineEnabled: gates.line, gridPresent: true, gridStaLost: false,
      slotsOn: chargeNowOn && !glitch ? [1, 2, 3] : [], connectedSlots: [1, 2, 3], vitalsRed: false, socCoherent: true,
      slotSocPct: { 1: seen, 2: seen, 3: seen },
      ceilingReadbackPct: panelCeiling, poolSocPct: seen, fullKwh: NAME, chargeRateKw, evDisplacedKwh,
    } as ForceChargeOpts;
    // (review 2) index.ts: the night's observations (the pool trail, the panel's own stop) on the record before
    // the decision; and on a tick that decides nothing, the line-at-risk push (once a night).
    const obs = nfc.lineNightObservations(s, t, o);
    if (obs != null) s = { ...s, ...obs };
    const a = decideForceCharge(s, t, o);
    // (Fix8 review 1) index.ts's judgeLineNight: the line-at-risk push (once a night, stamped before it goes) and the ON-reading
    // shape log (once a night, stamped on the record before it is logged), on every tick kind index.ts judges.
    const judge = (): void => {
      if (pushedAtMs == null) {
        const risk = nfc.lineAtRiskPushDue(s, t, o);
        if (risk != null) {
          pushedAtMs = t; pushCause = risk.cause; pushRetryPossible = risk.reOnRetryPossible; s = { ...s, forceChargeLineAtRiskPushedAtMs: t };
          // (review 5) 'reOnPerson': the person switches Charge Now on in the app 5 min after a push naming slots reading OFF.
          if (variant === 'reOnPerson' && risk.offSlots.length > 0 && !chargeNowOn) { onEffectiveMs = t + 5 * MIN; personPending = true; }
        }
      }
      if (shapeAtMs == null && nfc.lineOnReadingShape(s, t, o) != null) { shapeAtMs = t; s = { ...s, forceChargeLineShapeLoggedAtMs: t }; }
    };
    if (a.kind === 'none') judge();
    if (a.kind === 'syncCeiling') {
      s = { ...s, forceChargeCeilingAttemptedAtMs: t, forceChargeCeilingPriorPct: s.forceChargeCeilingPriorPct ?? a.prior, forceChargeCeilingSyncedPct: a.pct };
      pendingCeiling = a.pct;
      // (Fix8) index.ts: while ON (the line ceiling lowering), the line-at-risk push is judged after it, on its own tick.
      if (s.forceChargeOnAtMs != null) judge();
    } else if (a.kind === 'on') {
      // F-iii's emulation: the ON honoured only once a start timed to ⌈L⌉ alone (no + 5) is due.
      if (variant !== 'askStart' || t >= nfc.forceChargeLineStartAtMs(W1, ask, seen, NAME, chargeRateKw, evDisplacedKwh, 3)) {
        s = { ...s, ...nfc.forceChargeOnStamp(s, t, a.slots, gates), forceChargeOnLastAttemptMs: t } as LineState;
        onEffectiveMs = t + kn.onDelayMin * MIN;
        onWrites += 1;
      }
    } else if (a.kind === 'onVerified') {
      s = { ...s, forceChargeOnVerifiedAtMs: t };
    } else if (a.kind === 'onRetry') {
      s = { ...s, forceChargeOnRetries: s.forceChargeOnRetries + 1, forceChargeOnLastAttemptMs: t };
      onEffectiveMs = t + kn.onDelayMin * MIN;
      onWrites += 1;
    } else if (a.kind === 'lineReOn') {
      if (variant === 'reOnLimited' && !handedBack) {
        // (review 5) index.ts: every write rate-limited — the count handed back, no slots, the stamp moved to the write.
        // (review 6) …stamped `lagMs` after the tick (Date.now() after the writes). (review 8) …and the push judged on this,
        // the hand-back's own tick, after the stamp (index.ts judgeLineNight).
        handedBack = true; handBackAtMs = t;
        s = { ...s, forceChargeLineReOnAtMs: t + kn.lagMs, forceChargeLineReOnSlots: null };
        judge();
      } else if (variant !== 'noReOn') {
        if (handBackAtMs != null && retryAtMs == null) retryAtMs = t;
        s = { ...s, forceChargeLineReOns: s.forceChargeLineReOns + 1, forceChargeLineReOnAtMs: t + kn.lagMs, forceChargeLineReOnSlots: [...a.slots] };
        // 'reOnInert' ('reOnPerson'): the write is accepted and stamped, and the slots keep reading OFF. 'reOnLate': it
        // takes effect a minute after its readback check.
        if (variant !== 'reOnInert' && variant !== 'reOnPerson') {
          onEffectiveMs = t + (variant === 'reOnLate' ? nfc.FORCE_CHARGE_ON_VERIFY_AFTER_MS + MIN : kn.onDelayMin * MIN);
        }
        reOns += 1;
        onWrites += 1;
      }
    } else if (a.kind === 'lineReOnChecked') {
      // (review 2) index.ts records the re-ON's readback check; the budget's next re-ON is the retry. (review 4) Through
      // the same pure stamp index.ts persists (the latest re-ON that took effect included).
      s = { ...s, ...nfc.lineReOnCheckedStamp(s, t, a) };
      if (a.notApplied.length > 0 && a.notApplied.length === a.slots.length) reOnsFailed += 1;
      lastCheckAtMs = t; reOnsAtLastCheck = s.forceChargeLineReOns;
      // (Fix8 review 1) index.ts: judged on the check's own tick, after its stamp (the check writes nothing: the readings stand).
      if (kn.judgeCheck) judge();
    } else if (a.kind === 'off') {
      s = { ...s, forceChargeOffAtMs: t, forceChargeOffReason: a.reason };
      chargeNowOn = false; onEffectiveMs = null;
    }
    // F-i's emulation: a software stop at ⌈L⌉ (design A's hold without its drain allowance).
    if (variant === 'hold' && chargeNowOn && seen >= ask) { chargeNowOn = false; onEffectiveMs = null; s = { ...s, forceChargeOffAtMs: t, forceChargeOffReason: 'target' }; }
    if (chargeNowOn && importing && pack < (panelCeiling / 100) * CAP) {
      pack = Math.min((panelCeiling / 100) * CAP, pack + Math.max(1, (17 - load) * LEG) * k * (MIN / H));
      onMin += 1;
    } else {
      // At the ceiling the panel switches the slots OFF by itself, and they stay OFF (measured). 'onLatch': they
      // stop importing and keep reading ON (unmeasured).
      if (chargeNowOn) {
        onMin += 1;
        if (variant === 'onLatch') { if (importing) lossAtMs = t; importing = false; } else {
          chargeNowOn = false;
          if (personOnAtMs != null && personStopAtMs == null) personStopAtMs = t;
        }
      }
      if (pack > 0.5 * CAP) pack = Math.max(0.5 * CAP, pack - (load / DIS + kn.standbyKw) * (MIN / H));
    }
  }
  tail.sort((x, y) => x - y);
  const m = Math.floor(tail.length / 2);
  const close = tail.length % 2 ? tail[m] : (tail[m - 1] + tail[m]) / 2;
  // (review 6) The morning account of a night whose person's ON the panel stopped: index.ts's builders on the record the window
  // closes (the window's OFF).
  let stopNamed = false;
  if (personStopAtMs != null) {
    const fc = nfc.forceChargeNightOutcome({ ...s, forceChargeOffAtMs: W1, forceChargeOffReason: 'windowEnd' }, gates);
    stopNamed = buildNightChargeMorningSummary({ day: s.day, targetPct: 50, restorePct: 30, expectedKwh: 17.6, forceCharge: fc, closePoolPct: close, linePct: L } as never)
      .body.includes("until the panel's own stop switched Charge Now off at");
  }
  return {
    close, onMin, reOns, reOnsFailed, pushedAtMs, shapeAtMs, lossAtMs, pushCause, pushRetryPossible, lastCheckAtMs, reOnsAtLastCheck,
    handBackAtMs, retryAtMs, personOnAtMs, personStopAtMs, panelOffAtMs: s.forceChargeLinePanelOffAtMs ?? null, stopNamed, onWrites,
  };
}

const YEAR_LINES = [50.45, 50.61, 51.15, 51.43, 52.62, 54.33, 55.55, 57.52, 59.1, 65.95];
const HIGH_LINES = [69.5, 72.2, 74.6, 77.1, 80.3, 84.9, 89.6];
const HOUSES = [0.6, 1.2, 2.0, 2.8, 3.6];
const KS = [0.9, 1.0, 1.1, 1.25];

/** (review 2) `pushed` — nights the line-at-risk push went; `underPushed` — of the nights under, those it reached;
 *  `latePushed` — pushes at or inside FORCE_CHARGE_LINE_AT_RISK_LEAD_MS of the close (the helper never makes one).
 *  (review 3) `underPushedEarly` — of the nights under, those whose only push came BEFORE the event that lost the line
 *  ('onLatch': the latch), a once-a-night budget spent on a pool still charging; `shapes` — nights the ON-reading-shape
 *  log fired; `heldPushes` — pushes whose cause is 'reOnHeld'. (review 5) `refusedPushes` — pushes whose cause is
 *  'reOnRefused' (a handed-back re-ON whose retry the cutoff refuses). (review 6) `handBacks` — nights with a hand-back;
 *  `lost` — of them, those with neither its retry nor a push though a tick came between the hand-back and the lead;
 *  `lastTick` — those handed back on the last tick before the re-ON's cutoff with no retry and no push (the next tick is at or
 *  past the cutoff and the push's lead; review 8 pushes on the hand-back's own tick); `refusedRetried` — a 'reOnRefused'
 *  push followed by the retry (review 8: allowed, its words say the add-on may try once more); (review 8) `refusedSure` — the
 *  'reOnRefused' pushes worded "its next try would come after ~<cutoff>" (the stamp + 15 min at or past the re-ON's cutoff: no
 *  tick can bring the retry), `sureRetried` — of them, any the retry then followed (words the night contradicts);
 *  `personOn` — nights a person's ON took effect; `personStop` — of them, those the panel stopped at its ceiling after it;
 *  `stopStamped` — of those, the panel's stop on the record after the person's ON; `stopNamed` — the morning account naming
 *  the panel's stop as what ended the charge. */
function cell(lines: number[], kn: Partial<Knobs>, ks: number[] = KS, variant: Variant = 'real'): {
  under: number; n: number; worst: number; meanOn: number; reOns: number; pushed: number; underPushed: number; latePushed: number;
  underPushedEarly: number; shapes: number; heldPushes: number; refusedPushes: number;
  handBacks: number; lost: number; lastTick: number; refusedRetried: number; refusedSure: number; sureRetried: number;
  personOn: number; personStop: number; stopStamped: number; stopNamed: number;
  maxOnWrites: number;
} {
  const k2 = { ...BASE, ...kn };
  let under = 0, n = 0, worst = Infinity, on = 0, reOns = 0, pushed = 0, underPushed = 0, latePushed = 0, underPushedEarly = 0, shapes = 0, heldPushes = 0, refusedPushes = 0;
  let handBacks = 0, lost = 0, lastTick = 0, refusedRetried = 0, refusedSure = 0, sureRetried = 0, personOn = 0, personStop = 0, stopStamped = 0, stopNamed = 0, maxOnWrites = 0;
  for (const L of lines) for (const h of HOUSES) for (const k of ks) {
    const r = night(L, h, k, k2, variant);
    n += 1; on += r.onMin; reOns += r.reOns; worst = Math.min(worst, r.close - L); maxOnWrites = Math.max(maxOnWrites, r.onWrites);
    if (r.shapeAtMs != null) shapes += 1;
    if (r.handBackAtMs != null) {
      handBacks += 1;
      if (r.retryAtMs == null && r.pushedAtMs == null) {
        if (r.handBackAtMs + MIN >= W1 - nfc.FORCE_CHARGE_LINE_AT_RISK_LEAD_MS) lastTick += 1; else lost += 1;
      }
      if (r.pushCause === 'reOnRefused' && r.retryAtMs != null && r.pushedAtMs != null && r.retryAtMs > r.pushedAtMs) {
        refusedRetried += 1;
        if (!r.pushRetryPossible) sureRetried += 1;
      }
      if (r.pushCause === 'reOnRefused' && !r.pushRetryPossible) refusedSure += 1;
    }
    if (r.personOnAtMs != null) {
      personOn += 1;
      if (r.personStopAtMs != null) {
        personStop += 1;
        if (r.panelOffAtMs != null && r.panelOffAtMs > r.personOnAtMs) stopStamped += 1;
        if (r.stopNamed) stopNamed += 1;
      }
    }
    if (r.pushedAtMs != null) {
      pushed += 1;
      if (r.pushedAtMs >= W1 - nfc.FORCE_CHARGE_LINE_AT_RISK_LEAD_MS) latePushed += 1;
      if (r.pushCause === 'reOnHeld') heldPushes += 1;
      if (r.pushCause === 'reOnRefused') refusedPushes += 1;
    }
    if (r.close < L - 0.05) {
      under += 1;
      if (r.pushedAtMs != null) { underPushed += 1; if (r.lossAtMs != null && r.pushedAtMs < r.lossAtMs) underPushedEarly += 1; }
    }
  }
  return {
    under, n, worst, meanOn: on / n, reOns, pushed, underPushed, latePushed, underPushedEarly, shapes, heldPushes, refusedPushes,
    handBacks, lost, lastTick, refusedRetried, refusedSure, sureRetried, personOn, personStop, stopStamped, stopNamed, maxOnWrites,
  };
}

const STRESSES: Array<[string, Partial<Knobs>]> = [
  ['baseline (pool 50 at the open)', {}],
  ['0.27 kW standby', { standbyKw: 0.27 }],
  ['ON 5 min late', { onDelayMin: 5 }],
  ['reading 3 min stale', { staleMin: 3 }],
  ['EV 7 kW from 15 min before the close', { evFromMin: 15 }],
  ['EV 7 kW from 25 min before the close', { evFromMin: 25 }],
  ['EV 7 kW from 30 min before the close', { evFromMin: 30 }],
  ['EV 7 kW from 60 min before the close', { evFromMin: 60 }],
  ['EV 7 kW from 90 min before the close', { evFromMin: 90 }],
  ['pool 60 at the open', { p0: 60 }],
  ['pool 77 at the open', { p0: 77 }],
  ['pool 77 at the open + EV from 30 min', { p0: 77, evFromMin: 30 }],
  ['all: standby, ON 5 min late, 3 min stale', { standbyKw: 0.27, onDelayMin: 5, staleMin: 3 }],
];

/** The tick's evDisplacedKwh as index.ts passes it: a PREDICTED EV pulls the start early, the pool reaches
 *  the panel ceiling and latches, and the real EV (later, or larger) draws it back down — the review's case. */
const PREDICTED: Array<[string, Partial<Knobs>]> = [
  ['20 kWh predicted, 7 kW EV from 60 min', { predEvKwh: 20, evFromMin: 60 }],
  ['20 kWh predicted, 7 kW EV from 90 min', { predEvKwh: 20, evFromMin: 90 }],
  ['30 kWh predicted, 11 kW EV from 90 min', { predEvKwh: 30, evKw: 11, evFromMin: 90 }],
  ['30 kWh predicted, 11 kW EV from 120 min', { predEvKwh: 30, evKw: 11, evFromMin: 120 }],
  ['predicted exactly, 7 kW EV from 90 min', { predEvKwh: 'exact', evFromMin: 90 }],
  ['predicted exactly, 11.52 kW EV from 90 min', { predEvKwh: 'exact', evKw: EV_MAX_KW, evFromMin: 90 }],
  ['predicted exactly, 11.52 kW EV from 120 min', { predEvKwh: 'exact', evKw: EV_MAX_KW, evFromMin: 120 }],
  ['36 kWh predicted, 11.52 kW EV from 90 min', { predEvKwh: 36, evKw: EV_MAX_KW, evFromMin: 90 }],
  ['36 kWh predicted, 11.52 kW EV from 180 min', { predEvKwh: 36, evKw: EV_MAX_KW, evFromMin: 180 }],
  ['pool 77 + 20 kWh predicted, 7 kW EV from 90 min', { p0: 77, predEvKwh: 20, evFromMin: 90 }],
  ['all: standby, ON 5 min late, 3 min stale + 20 kWh predicted, 7 kW EV from 90 min',
    { standbyKw: 0.27, onDelayMin: 5, staleMin: 3, predEvKwh: 20, evFromMin: 90 }],
];

test('★★★ T7 the year-shaped lines close at or above the line in EVERY stress cell: 0 under, rounded and floored readings', () => {
  const out: string[] = [];
  for (const floor of [false, true]) {
    for (const [name, kn] of STRESSES) {
      const r = cell(YEAR_LINES, { ...kn, floor });
      out.push(`${name}${floor ? ' (floor)' : ''}: ${r.under}/${r.n}`);
      assert.equal(r.under, 0, `${name}${floor ? ' (floor)' : ''}: ${r.under}/${r.n} under, worst close − L ${r.worst.toFixed(2)}`);
      // (review 2) and the line-at-risk push never goes on them: a carried night with no latch is never a warning.
      assert.equal(r.pushed, 0, `${name}${floor ? ' (floor)' : ''}: ${r.pushed} pushed`);
      // (review 3) nor the ON-reading-shape log: the plant's latch is the measured one (the slots read OFF).
      assert.equal(r.shapes, 0, `${name}${floor ? ' (floor)' : ''}: the shape logged on ${r.shapes}`);
    }
    for (const k of [0.7, 0.6]) {
      const r = cell(YEAR_LINES, { floor }, [k]);
      assert.equal(r.under, 0, `the pack takes ${k} of the rate${floor ? ' (floor)' : ''}: ${r.under}/${r.n}`);
    }
  }
  assert.ok(out.length === 26);
});

test('★★★ T7 (review) a PREDICTED EV pulls the start early and the panel latches OFF at its ceiling: the re-ON closes every cell at or above the line, year and high asks', () => {
  for (const floor of [false, true]) {
    for (const [name, kn] of PREDICTED) {
      for (const [lines, label] of [[YEAR_LINES, 'year'], [HIGH_LINES, 'high asks']] as const) {
        const r = cell(lines as number[], { ...kn, floor });
        assert.equal(r.under, 0, `${name}, ${label}${floor ? ' (floor)' : ''}: ${r.under}/${r.n} under, worst close − L ${r.worst.toFixed(2)}`);
        // (review 3) The re-ON working is never logged as the unmeasured ON-reading latch (the tick after it reads the
        // slots ON, the pool still below a reading from before it), and no push blames the re-ON's gates (none hold here).
        assert.equal(r.shapes, 0, `${name}, ${label}${floor ? ' (floor)' : ''}: the ON-reading shape logged on ${r.shapes} nights of the measured latch`);
        assert.equal(r.heldPushes, 0, `${name}, ${label}${floor ? ' (floor)' : ''}: ${r.heldPushes} 'reOnHeld' pushes`);
      }
    }
  }
  // The re-ON is what carries them: it fires on these nights (and never on the plain year cells).
  assert.ok(cell(YEAR_LINES, { predEvKwh: 30, evKw: 11, evFromMin: 90 }).reOns >= 40);
  assert.equal(cell(YEAR_LINES, {}).reOns, 0);
});

test('★★★ T7 (review 2) the ON-READING latch — UNMEASURED here: no re-ON keys on a slot reading ON, so predicted-EV nights close under; pinned exactly, and the line-at-risk push reaches every one of them ≥ 20 min before the close', () => {
  const got: Record<string, Array<[number, number]>> = {};
  let real = { round: 0, floor: 0 };
  let early = 0;
  for (const [name, kn] of PREDICTED) {
    got[name] = [];
    for (const [lines, floor] of [[YEAR_LINES, false], [YEAR_LINES, true], [HIGH_LINES, false], [HIGH_LINES, true]] as const) {
      const r = cell(lines as number[], { ...kn, floor }, KS, 'onLatch');
      got[name].push([r.under, r.pushed]);
      assert.equal(r.underPushed, r.under, `${name} (${lines === YEAR_LINES ? 'year' : 'high'}${floor ? ', floor' : ''}): the push reached ${r.underPushed} of ${r.under} under`);
      assert.equal(r.latePushed, 0, 'never inside the lead');
      // (review 3) …and AFTER the latch that lost the line: a push spent on a pool still charging is no reach.
      early += r.underPushedEarly;
      // The shape log fires on every night of the latch that closes under (its first real occurrence goes on record).
      assert.ok(r.shapes >= r.under, `${name}: the shape logged on ${r.shapes} of ${r.under} under`);
      const m = cell(lines as number[], { ...kn, floor });
      assert.equal(m.under, 0, 'the measured (OFF-reading) latch: carried by the re-ON');
      real = { ...real, [floor ? 'floor' : 'round']: real[floor ? 'floor' : 'round'] + m.pushed };
    }
  }
  assert.deepEqual(got, PIN_ON_LATCH);
  assert.deepEqual(real, PIN_REAL_PREDICTED_PUSHES);
  assert.equal(early, PIN_ON_LATCH_PUSHED_BEFORE_LATCH, 'under nights whose only push came before the latch');
  // The shape is what the once-a-night log names: a slot of ours reading ON, its Core under the ceiling, the pool falling.
  const s = { ...emptyActuationState(), day: '2027-01-04', windowStartMs: W0, windowEndMs: W1, forceChargeLineAskPct: 56, forceChargeLinePct: 55.55,
    forceChargeOnAtMs: W0, forceChargeSlots: [1, 2, 3], forceChargeOnVerifiedAtMs: W0 + MIN, forceChargeCeilingSyncedPct: 80,
    forceChargeLinePoolSamples: [{ pct: 66, atMs: W1 - 70 * MIN }] } as LineState;
  const o = { enabled: false, lineEnabled: true, gridPresent: true, gridStaLost: false, slotsOn: [1, 2, 3], connectedSlots: [1, 2, 3],
    vitalsRed: false, socCoherent: true, slotSocPct: { 1: 62, 2: 62, 3: 62 }, ceilingReadbackPct: 80, poolSocPct: 62, fullKwh: NAME } as ForceChargeOpts;
  assert.deepEqual(nfc.lineOnReadingShape(s, W1 - H, o)?.slots, [1, 2, 3]);
});

test('★★★ T7 (review 4) a re-ON the cloud accepts that never takes effect (UNMEASURED here): the line-at-risk push reaches the nights it loses once the check says so; pinned exactly', () => {
  const got: Record<string, Array<[number, number]>> = {};
  const sum = { year: { n: 0, under: 0, reached: 0 }, high: { n: 0, under: 0, reached: 0 } };
  const unreached = { lead: 0, cutoffReOn: 0, other: 0 };
  const before = { year: 0, high: 0 };
  let held = 0;
  for (const [name, kn] of PREDICTED) {
    got[name] = [];
    for (const [lines, floor] of [[YEAR_LINES, false], [YEAR_LINES, true], [HIGH_LINES, false], [HIGH_LINES, true]] as const) {
      const r = cell(lines as number[], { ...kn, floor }, KS, 'reOnInert');
      got[name].push([r.under, r.underPushed]);
      assert.equal(r.latePushed, 0, 'never inside the lead');
      held += r.pushed - r.underPushed;
      const t = sum[lines === YEAR_LINES ? 'year' : 'high'];
      t.n += r.n; t.under += r.under; t.reached += r.underPushed;
      // (Fix8 review 1) The emulation before: the check's own tick not judged.
      before[lines === YEAR_LINES ? 'year' : 'high'] += cell(lines as number[], { ...kn, floor, judgeCheck: false }, KS, 'reOnInert').underPushed;
      // (Fix8 review 1) Why each night under is not reached: its last check came at or inside the push's lead, or — on the last tick
      // before the re-ON's cutoff, with a re-ON left — the re-ON due there holds the push and waits a tick (the check took this one),
      // and the next tick is the cutoff (no re-ON) and the lead (no push).
      for (const L of lines as number[]) for (const hk of HOUSES) for (const k of KS) {
        const n = night(L, hk, k, { ...BASE, ...kn, floor }, 'reOnInert');
        if (!(n.close < L - 0.05) || n.pushedAtMs != null) continue;
        if (n.lastCheckAtMs != null && n.lastCheckAtMs >= W1 - nfc.FORCE_CHARGE_LINE_AT_RISK_LEAD_MS) unreached.lead += 1;
        else if (n.lastCheckAtMs != null && n.reOnsAtLastCheck < nfc.FORCE_CHARGE_LINE_REON_MAX && n.lastCheckAtMs + MIN >= W1 - nfc.FORCE_CHARGE_ON_RETRY_CUTOFF_MS) unreached.cutoffReOn += 1;
        else unreached.other += 1;
      }
    }
  }
  assert.deepEqual(got, PIN_REON_INERT);
  assert.deepEqual(sum, PIN_REON_INERT_SUM);
  assert.deepEqual(unreached, PIN_REON_INERT_UNREACHED);
  assert.deepEqual(before, PIN_REON_INERT_BEFORE_CHECK_JUDGED);
  assert.equal(held, PIN_REON_INERT_HELD_PUSHES, 'pushes on nights that still held');
  // The round-4 reviewer's night: L 65.95, a 3.6 kW house, k 1.25, 20 kWh predicted, a 7 kW EV from 90 min. Both re-ONs (54
  // and 38 min before the close) are checked not applied (39 and 23 min before) and the night closes at 60: (Fix8 review 1) the
  // push goes on the second check's own tick, 23 min before the close (the minute after it before), naming the re-ON that has not
  // taken effect. Judged against the not-applied re-ON as an ON of ours, the earliest reference came 25 min after it — inside the
  // 20-min lead: no push.
  const ex = night(65.95, 3.6, 1.25, { ...BASE, predEvKwh: 20, evFromMin: 90 }, 'reOnInert');
  assert.deepEqual([ex.close, ex.reOns, ex.reOnsFailed, ex.pushCause], [60, 2, 2, 'reOnNotApplied']);
  assert.equal(ex.pushedAtMs, W1 - 23 * MIN);
  assert.equal(ex.lastCheckAtMs, W1 - 23 * MIN);
  assert.equal(night(65.95, 3.6, 1.25, { ...BASE, predEvKwh: 20, evFromMin: 90, judgeCheck: false }, 'reOnInert').pushedAtMs, W1 - 22 * MIN);
});

test('★★★ T7 (review 5) an ON seen on the readback that no ON write of ours explains is waited out — a re-ON applied after its check, a glitch at the check, Charge Now switched on by a person after the push — and a handed-back re-ON\'s retry is never pushed as the gates; pinned exactly', () => {
  const got: Record<string, { under: number; reached: number; held: number; shapes: number; heldCause: number; refused: number }> = {};
  for (const variant of ['reOnLate', 'reOnGlitch', 'reOnPerson', 'reOnLimited'] as const) {
    const t = { under: 0, reached: 0, held: 0, shapes: 0, heldCause: 0, refused: 0 };
    for (const [, kn] of PREDICTED) {
      for (const [lines, floor] of [[YEAR_LINES, false], [YEAR_LINES, true], [HIGH_LINES, false], [HIGH_LINES, true]] as const) {
        const r = cell(lines as number[], { ...kn, floor }, KS, variant);
        assert.equal(r.latePushed, 0, `${variant}: never inside the lead`);
        t.under += r.under; t.reached += r.underPushed; t.held += r.pushed - r.underPushed;
        t.shapes += r.shapes; t.heldCause += r.heldPushes; t.refused += r.refusedPushes;
      }
    }
    got[variant] = t;
  }
  // The ON-reading shape is never logged on any of them: each is an ON that works (the round-5 reviewer's emulation logged it
  // on 3,271 late nights, 101 glitch nights and 2,476 nights a person followed the push). And no handed-back re-ON's push
  // blames the gates ('reOnHeld': 3,256 of the reviewer's 3,263 limited pushes, 3,142 of them on nights that held).
  for (const [v, t] of Object.entries(got)) {
    assert.equal(t.shapes, 0, `${v}: the ON-reading shape logged on ${t.shapes} nights`);
    assert.equal(t.heldCause, 0, `${v}: ${t.heldCause} 'reOnHeld' pushes`);
  }
  assert.deepEqual(got, PIN_REVIEW5);
});

test('★★★ T7 (review 6, review 8) with the ticks off the minute and each re-ON stamped after its writes, every handed-back re-ON gets its retry or the push — never neither, a push then the retry counted; a person\'s ON the panel then stops is stamped and named; pinned exactly', () => {
  const runs: Array<[string, Variant, Partial<Knobs>]> = [
    ['reOnLimited, stamped 2 s after its tick', 'reOnLimited', { lagMs: 2_000 }],
    ['reOnLimited, ticks 30 s off the minute, stamped 2 s after', 'reOnLimited', { phaseMs: 30_000, lagMs: 2_000 }],
    ['reOnPerson', 'reOnPerson', {}],
  ];
  const got: Record<string, Record<string, number>> = {};
  for (const [label, variant, knobs] of runs) {
    const t = { under: 0, reached: 0, held: 0, shapes: 0, heldCause: 0, refused: 0, handBacks: 0, lost: 0, lastTick: 0, refusedRetried: 0,
      refusedSure: 0, sureRetried: 0, personOn: 0, personStop: 0, stopStamped: 0, stopNamed: 0 };
    for (const [, kn] of PREDICTED) {
      for (const [lines, floor] of [[YEAR_LINES, false], [YEAR_LINES, true], [HIGH_LINES, false], [HIGH_LINES, true]] as const) {
        const r = cell(lines as number[], { ...kn, ...knobs, floor }, KS, variant);
        assert.equal(r.latePushed, 0, `${label}: never inside the lead`);
        t.under += r.under; t.reached += r.underPushed; t.held += r.pushed - r.underPushed;
        t.shapes += r.shapes; t.heldCause += r.heldPushes; t.refused += r.refusedPushes;
        t.handBacks += r.handBacks; t.lost += r.lost; t.lastTick += r.lastTick; t.refusedRetried += r.refusedRetried;
        t.refusedSure += r.refusedSure; t.sureRetried += r.sureRetried;
        t.personOn += r.personOn; t.personStop += r.personStop; t.stopStamped += r.stopStamped; t.stopNamed += r.stopNamed;
      }
    }
    got[label] = t;
  }
  for (const [label, t] of Object.entries(got)) {
    // No hand-back loses both its retry and the push (eed0363a held the push while the stamp + 15 min fell before the cutoff,
    // and the retry came a tick later, past it); (review 8) nor one on the last tick before the cutoff (pushed on its own
    // tick). A 'reOnRefused' push may be followed by the retry (its words say the add-on may try once more): counted, pinned.
    assert.equal(t.lost + t.lastTick, 0, `${label}: ${t.lost + t.lastTick} hand-backs with neither the retry nor the push`);
    // (review 8) …and one worded "its next try would come after ~<cutoff>" is never followed by the retry.
    assert.equal(t.sureRetried, 0, `${label}: ${t.sureRetried} pushes saying no tick can bring the retry, then the retry`);
    assert.equal(t.shapes + t.heldCause, 0, `${label}: shape logs or 'reOnHeld' pushes`);
    // A person's ON that the panel stops at its ceiling is a stop on the record, and the morning names it.
    assert.equal(t.stopStamped, t.personStop, `${label}: ${t.stopStamped} of ${t.personStop} stops after the person's ON stamped`);
    assert.equal(t.stopNamed, t.personStop, `${label}: ${t.stopNamed} of ${t.personStop} named by the morning account`);
  }
  assert.deepEqual(got, PIN_REVIEW6);
});

/** (review 8) Every night WITHOUT a hand-back, fingerprinted (FNV-1a over each night's close, ON minutes, re-ONs, failed
 *  re-ONs, push instant and cause, shape-log instant and ON-kind writes), per variant over every PREDICTED cell (year and
 *  70-90% lines, rounded and floored): measured on 31e87ca4 before the review-8 hold, and unchanged by it — the full-tick
 *  margin and the push on the hand-back's own tick touch only a night with a hand-back. */
const PIN_REVIEW8_IDENTITY: Record<string, { nights: number; fnv: string }> = {
  real: { nights: 7480, fnv: '84fe8d1f' }, onLatch: { nights: 7480, fnv: 'b154cb0c' }, reOnInert: { nights: 7480, fnv: 'b5faf202' },
  reOnLate: { nights: 7480, fnv: '29a9ab56' }, reOnGlitch: { nights: 7480, fnv: 'edd54d84' }, reOnPerson: { nights: 7480, fnv: 'a70a011e' },
  'reOnLimited, stamped 2 s after its tick (nights with no hand-back)': { nights: 4202, fnv: 'c829e4a1' },
};
/** (Fix8 review 1) …and with the re-ON's check judged on its own tick (index.ts now): the variants whose re-ONs are checked not
 *  applied move (reOnInert, reOnLate, reOnGlitch, reOnPerson: PIN_REON_INERT, PIN_REVIEW5); every other stays as on 31e87ca4. With
 *  that tick not judged the fingerprints are PIN_REVIEW8_IDENTITY's, so nothing else this round changed moves a night. */
const PIN_FIX8R1_IDENTITY: Record<string, { nights: number; fnv: string }> = {
  ...PIN_REVIEW8_IDENTITY,
  reOnInert: { nights: 7480, fnv: '4beb6caa' }, reOnLate: { nights: 7480, fnv: '14428a3f' }, reOnGlitch: { nights: 7480, fnv: '1feebfdb' },
  reOnPerson: { nights: 7480, fnv: 'c6138fc0' },
};
test('★★★ T7 (review 8) identity: no night without a hand-back changes — every PREDICTED night of every variant, and the reOnLimited nights with none, fingerprinted as on 31e87ca4; (Fix8 review 1) the check\'s own tick judged moves only the variants checked not applied', () => {
  const fnv = (h: number, str: string): number => { for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h; };
  const runs: Array<[string, Variant, Partial<Knobs>]> = [
    ['real', 'real', {}], ['onLatch', 'onLatch', {}], ['reOnInert', 'reOnInert', {}], ['reOnLate', 'reOnLate', {}],
    ['reOnGlitch', 'reOnGlitch', {}], ['reOnPerson', 'reOnPerson', {}],
    ['reOnLimited, stamped 2 s after its tick (nights with no hand-back)', 'reOnLimited', { lagMs: 2_000 }],
  ];
  const fingerprints = (judgeCheck: boolean): Record<string, { nights: number; fnv: string }> => {
    const got: Record<string, { nights: number; fnv: string }> = {};
    for (const [label, variant, knobs] of runs) {
      let h = 2166136261;
      let nights = 0;
      for (const [, kn] of PREDICTED) {
        for (const [lines, floor] of [[YEAR_LINES, false], [YEAR_LINES, true], [HIGH_LINES, false], [HIGH_LINES, true]] as const) {
          for (const L of lines as number[]) for (const hk of HOUSES) for (const k of KS) {
            const r = night(L, hk, k, { ...BASE, ...kn, ...knobs, floor, judgeCheck }, variant);
            if (r.handBackAtMs != null) continue;
            nights += 1;
            h = fnv(h, `${L}|${hk}|${k}|${floor}|${r.close}|${r.onMin}|${r.reOns}|${r.reOnsFailed}|${r.pushedAtMs}|${r.pushCause}|${r.shapeAtMs}|${r.onWrites};`);
          }
        }
      }
      got[label] = { nights, fnv: h.toString(16).padStart(8, '0') };
    }
    return got;
  };
  assert.deepEqual(fingerprints(false), PIN_REVIEW8_IDENTITY);
  assert.deepEqual(fingerprints(true), PIN_FIX8R1_IDENTITY);
});

test('★★★ T7 the line force-charge actually runs: ON to the close on a 50% pool, no OFF before it', () => {
  const r = night(55.55, 2.0, 1.0, BASE, 'real');
  assert.ok(r.onMin >= 35, `ON ${r.onMin} min`);
  assert.ok(r.close >= 56, `close ${r.close}`);
  // A pool already above the start target still gets the final segment ON (under the panel ceiling).
  assert.ok(night(55.55, 2.0, 1.0, { ...BASE, p0: 77 }, 'real').onMin >= 30);
});

test('★★★ T7 known failures at asks of 70-90 (the window cannot deliver to a slow pack), pinned so a regression is seen', () => {
  for (const floor of [false, true]) {
    const pin = floor ? PIN_HIGH.floor : PIN_HIGH.round;
    for (const [name, kn] of STRESSES) {
      const r = cell(HIGH_LINES, { ...kn, floor });
      const known = name.startsWith('EV 7 kW from 90') ? pin.ev90 : 0;
      assert.equal(r.under, known, `${name}${floor ? ' (floor)' : ''}: ${r.under}/${r.n}`);
    }
    assert.equal(cell(HIGH_LINES, { floor }, [0.7]).under, pin.rate07, `rate 0.7${floor ? ' (floor)' : ''}`);
    assert.equal(cell(HIGH_LINES, { floor }, [0.6]).under, pin.rate06, `rate 0.6${floor ? ' (floor)' : ''}`);
  }
  // The mean ON time on these lines (the exposure the CHANGELOG states), against the year's.
  assert.equal(Math.round(cell(HIGH_LINES, {}).meanOn), MEAN_ON.high);
  assert.equal(Math.round(cell(YEAR_LINES, {}).meanOn), MEAN_ON.year);
  assert.equal(Math.round(cell(YEAR_LINES, { predEvKwh: 20, evFromMin: 90 }).meanOn), MEAN_ON_PREDICTED_EV);
});

test('★★★ T7 (review) known failures: a late UNPREDICTED load that takes the grid cap after the start, alone or combined — pinned exactly, never claimed carried', () => {
  const got: Record<string, [number, number, number, number]> = {};
  for (const [name, kn, ks] of KNOWN_CELLS) {
    const r = (lines: number[], floor: boolean) => cell(lines, { ...kn, floor }, ks).under;
    got[name] = [r(YEAR_LINES, false), r(YEAR_LINES, true), r(HIGH_LINES, false), r(HIGH_LINES, true)];
  }
  assert.deepEqual(got, PIN_KNOWN);
  // (review 2) The line-at-risk push on those nights: the under nights it reached, pinned (it needs the pool not rising).
  const pushed: Record<string, [number, number, number, number]> = {};
  for (const [name, kn, ks] of KNOWN_CELLS) {
    const r = (lines: number[], floor: boolean) => { const c = cell(lines, { ...kn, floor }, ks); assert.equal(c.latePushed, 0); return c.underPushed; };
    pushed[name] = [r(YEAR_LINES, false), r(YEAR_LINES, true), r(HIGH_LINES, false), r(HIGH_LINES, true)];
  }
  assert.deepEqual(pushed, PIN_KNOWN_PUSHED);
});

test('★★ T7 (review) cost-dominant nights (the cost stop at ⌈L⌉ + 10 or above runs today\'s cost force-charge, with its software stop): pinned, never claimed carried', () => {
  const got: Record<string, [number, number, number, number]> = {};
  for (const [name, kn] of COST_CELLS) {
    const r = (lines: number[], floor: boolean) => cell(lines, { ...kn, floor }).under;
    got[name] = [r(YEAR_LINES, false), r(YEAR_LINES, true), r(HIGH_LINES, false), r(HIGH_LINES, true)];
  }
  assert.deepEqual(got, PIN_COST);
  // (review 3) The line-at-risk push on those nights: the under nights it reached. It goes only BEFORE the cost
  // force-charge's own software stop (an OFF of ours ends it), so a late EV after that stop is not pushed, nor a slow
  // pack still rising at the close — pinned.
  const reach: Record<string, [number, number, number, number]> = {};
  for (const [name, kn] of COST_CELLS) {
    const r = (lines: number[], floor: boolean) => { const c = cell(lines, { ...kn, floor }); assert.equal(c.latePushed, 0); return c.underPushed; };
    reach[name] = [r(YEAR_LINES, false), r(YEAR_LINES, true), r(HIGH_LINES, false), r(HIGH_LINES, true)];
  }
  assert.deepEqual(reach, PIN_COST_PUSHED);
  // Those nights ARE cost-dominant (the mode the tick runs), so the line's re-ON never rides them.
  const s = { ...emptyActuationState(), forceChargeCeilingPct: 66, forceChargeLineAskPct: 56 };
  assert.equal(nfc.forceChargeModeOf(s, { cost: true, line: true })?.kind, 'cost');
});

test('★★ T7 the discriminators: a software stop at ⌈L⌉, a start timed to ⌈L⌉ alone, and no re-ON after the latch close under the line on this grid', () => {
  // F-i (design A's hold, with no drain allowance): an EV 30 min before the close takes the pool back down.
  const hold = cell(YEAR_LINES, { evFromMin: 30 }, KS, 'hold');
  assert.ok(hold.under >= 150, `hold, EV 30 min out: ${hold.under}/${hold.n}`);
  // F-iii (no + 5): an EV 60 or 90 min out, or a slow pack, arrives short.
  const ask90 = cell(YEAR_LINES, { evFromMin: 90 }, KS, 'askStart');
  const ask60 = cell(YEAR_LINES, { evFromMin: 60 }, KS, 'askStart');
  const ask06 = cell(YEAR_LINES, {}, [0.6], 'askStart');
  // Measured: 17/200, 5/200 and 5/50 (the integrator's emulation: the same); the hold 200/200.
  assert.ok(ask90.under >= 15 && ask60.under >= 5, `start to ⌈L⌉: EV 90 ${ask90.under}, EV 60 ${ask60.under}`);
  assert.ok(ask06.under >= 5, `start to ⌈L⌉, rate 0.6: ${ask06.under}/${ask06.n}`);
  // No re-ON after the panel's latch (the review's finding): a predicted EV that arrives late closes under.
  const noReOn20 = cell(YEAR_LINES, { predEvKwh: 20, evFromMin: 90 }, KS, 'noReOn');
  const noReOn30 = cell(YEAR_LINES, { predEvKwh: 30, evKw: 11, evFromMin: 90 }, KS, 'noReOn');
  assert.ok(noReOn20.under >= 8 && noReOn30.under >= 40, `no re-ON: 20 kWh/7 kW from 90 ${noReOn20.under}, 30 kWh/11 kW from 90 ${noReOn30.under}`);
});

/* ══ T18 (A5) — a line within 10 points of a full pool: armed, run as a 90% line (start 95, ceiling 100), disclosed ═══ */

/** Near-full lines (⌈L⌉ 91-98), and lines at or above a full pool's reach (⌈L⌉ 100). */
const NEAR_LINES = [90.4, 91.6, 93.0, 94.6, 96.2, 97.9];
const TOP_LINES = [99.3, 100.4, 104.0];
const NEAR_CELLS: Array<[string, Partial<Knobs>, number[]?]> = [
  ['baseline (pool 50 at the open)', {}],
  ['20 kWh predicted, 7 kW EV from 90 min', { predEvKwh: 20, evFromMin: 90 }],
  ['7 kW EV all window, predicted', { predEvKwh: 'exact', evKw: 7, evFromMin: 360 }],
  ['pool 77 at the open', { p0: 77 }],
  ['the pack at 70% of the rate', {}, [0.7]],
];

test('★★ T18 (A5) near-full lines: the measured latch and the unmeasured ON-reading one, rounded and floored — the nights under the line, the line-at-risk push on them, ≤ 3 ON-kind writes a night; lines at or above a full pool pinned as known', () => {
  const got: Record<string, Record<string, [number, number, number, number]>> = { real: {}, onLatch: {} };
  const top: Record<string, [number, number]> = {};
  let maxWrites = 0;
  for (const variant of ['real', 'onLatch'] as const) {
    for (const [name, kn, ks] of NEAR_CELLS) {
      const r = cell(NEAR_LINES, { ...kn, floor: false }, ks ?? KS, variant);
      const f = cell(NEAR_LINES, { ...kn, floor: true }, ks ?? KS, variant);
      for (const c of [r, f]) { assert.equal(c.latePushed, 0, `${variant} ${name}: never inside the lead`); maxWrites = Math.max(maxWrites, c.maxOnWrites); }
      got[variant][name] = [r.under, f.under, r.underPushed, f.underPushed];
    }
  }
  for (const [name, kn, ks] of NEAR_CELLS) {
    const r = cell(TOP_LINES, { ...kn, floor: false }, ks ?? KS);
    top[name] = [r.under, r.n];
  }
  assert.ok(maxWrites <= 3, `ON-kind writes a night: ${maxWrites}`);
  assert.deepEqual(got, PIN_NEAR);
  assert.deepEqual(top, PIN_TOP);
  // The exposure: mean minutes Charge Now reads ON on the near-full lines (the measured latch, rounded).
  const meanOn = Object.fromEntries(NEAR_CELLS.slice(0, 3).map(([name, kn]) => [name, Math.round(cell(NEAR_LINES, kn).meanOn)]));
  assert.deepEqual(meanOn, PIN_NEAR_MEAN_ON);
  // The near-full line runs as a 90% line does: a 98% line's start target is 95, its ceiling 100 (never a start at or
  // above the ceiling, which would leave the re-ON nothing to re-ON from).
  assert.deepEqual(nfc.forceChargeModeOf({ forceChargeCeilingPct: null, forceChargeLineAskPct: 98 } as never, { cost: false, line: true }),
    { kind: 'line', targetPct: 98, askPct: 98, startTargetPct: 95, panelCeilingPct: 100 });
});

/** (A5) Measured on the landed change (962e4668's plant: the hand-back hold, the lagged stamps and the earliest-tick count
 *  change none of these), the near-full lines (6 lines × 5 houses × 4 rate factors = 120 nights a cell; 30 at a single
 *  rate factor): [under rounded, under floored, of them pushed rounded, pushed floored].
 *  - 'real': the measured latch (the panel's own OFF at its ceiling, read at 80 and 90% only — its stop at 100% is
 *    UNMEASURED). The nights under close so in the last 20 minutes (past the re-ON's cutoff and the push's lead) or still
 *    rising (the 70% rate): the push reaches none of them. The re-ON and the push key on the start target, 95, under a
 *    line of 96-98 (a residual, stated). Matches the design's and the critic's emulation on 11019c18's plant (rounded).
 *  - 'onLatch': a slot that keeps reading ON at its ceiling and stops importing (unmeasured anywhere): no re-ON keys on
 *    it, so a predicted EV that comes after the latch closes every near-full night under; the push reaches all 120 of
 *    the EV-90 cell and 34 of the 69 all-window ones (their fall comes too late for its 20-min lead). */
const PIN_NEAR: Record<string, Record<string, [number, number, number, number]>> = {
  real: {
    'baseline (pool 50 at the open)': [3, 6, 0, 0],
    '20 kWh predicted, 7 kW EV from 90 min': [19, 34, 0, 0],
    '7 kW EV all window, predicted': [41, 43, 0, 0],
    'pool 77 at the open': [1, 4, 0, 0],
    'the pack at 70% of the rate': [30, 30, 0, 0],
  },
  onLatch: {
    'baseline (pool 50 at the open)': [3, 6, 0, 0],
    '20 kWh predicted, 7 kW EV from 90 min': [120, 120, 120, 120],
    '7 kW EV all window, predicted': [69, 72, 34, 34],
    'pool 77 at the open': [1, 4, 0, 0],
    'the pack at 70% of the rate': [30, 30, 0, 0],
  },
};
/** (A5) Lines at or above what a full pool can hold to the close (99.3, 100.4, 104: ⌈L⌉ 100), the measured latch, rounded:
 *  [under, nights] — known, not claimed (the plan discloses every one: 'nearFull', 'aboveFull' above 100). */
const PIN_TOP: Record<string, [number, number]> = {
  'baseline (pool 50 at the open)': [56, 60],
  '20 kWh predicted, 7 kW EV from 90 min': [58, 60],
  '7 kW EV all window, predicted': [60, 60],
  'pool 77 at the open': [53, 60],
  'the pack at 70% of the rate': [15, 15],
};
/** (A5) Mean minutes a slot reads Charge Now ON on the near-full lines (the measured latch, rounded): the exposure a
 *  near-full night adds (v1.199.1 armed none on a resilience night). 294 / 359 with the predicted EV under the ON-reading
 *  latch (unmeasured). */
const PIN_NEAR_MEAN_ON: Record<string, number> = {
  'baseline (pool 50 at the open)': 182,
  '20 kWh predicted, 7 kW EV from 90 min': 224,
  '7 kW EV all window, predicted': 335,
};

/** Measured when the change was made (v1.200.0) on the real decideForceCharge. Rounded readings match the
 *  integrator's emulation (rtcSim4-highasks.out: 1/140, 8/35, 30/35); floored readings cost a point at the
 *  close. Out of 140 nights (7 lines × 5 houses × 4 rate factors), or 35 at a single rate factor. */
const PIN_HIGH = { round: { ev90: 1, rate07: 8, rate06: 30 }, floor: { ev90: 10, rate07: 11, rate06: 33 } };
/** Mean minutes a slot reads Charge Now ON (the exposure stated in the CHANGELOG and the docs), emulated: from
 *  the ON to the window close, or to the panel's own OFF at its ceiling (the latch). Before the plant modelled
 *  the latch these read 75 and 169; a predicted EV starts earlier and lengthens them (pinned below). */
const MEAN_ON = { year: 74, high: 142 };
/** …and on the year's lines with a 20 kWh EV predicted (a 7 kW one arriving 90 min out). */
const MEAN_ON_PREDICTED_EV = 138;

/** Known failures (review): the start is timed on the live rate, and an unpredicted load that arrives after
 *  it takes the grid cap the pack was timed on. [year rounded, year floored, high rounded, high floored]
 *  under, of 200 / 200 / 140 / 140 (50 / 50 / 35 / 35 at a single rate factor). */
const KNOWN_CELLS: Array<[string, Partial<Knobs>, number[]?]> = [
  ['unpredicted 7 kW EV from 120 min', { evFromMin: 120 }],
  ['unpredicted 11.52 kW EV from 60 min', { evKw: EV_MAX_KW, evFromMin: 60 }],
  ['unpredicted 11.52 kW EV from 90 min', { evKw: EV_MAX_KW, evFromMin: 90 }],
  ['unpredicted 11.52 kW EV from 120 min', { evKw: EV_MAX_KW, evFromMin: 120 }],
  ['ON 5 min late × unpredicted 7 kW EV from 90 min', { onDelayMin: 5, evFromMin: 90 }],
  ['pack at 0.85 of the rate × unpredicted 7 kW EV from 90 min', { evFromMin: 90 }, [0.85]],
];
const PIN_KNOWN: Record<string, [number, number, number, number]> = {
  'unpredicted 7 kW EV from 120 min': [5, 8, 45, 55],
  'unpredicted 11.52 kW EV from 60 min': [0, 1, 8, 18],
  'unpredicted 11.52 kW EV from 90 min': [73, 82, 87, 93],
  'unpredicted 11.52 kW EV from 120 min': [55, 61, 138, 139],
  'ON 5 min late × unpredicted 7 kW EV from 90 min': [1, 4, 19, 30],
  'pack at 0.85 of the rate × unpredicted 7 kW EV from 90 min': [1, 3, 29, 34],
};

/** Cost-dominant nights (review): the cost gate on with a cost ceiling at ⌈L⌉ + 10 or + 15 (≤ 100). */
const COST_CELLS: Array<[string, Partial<Knobs>]> = [
  ['cost ⌈L⌉ + 10, baseline', { costPct: (a) => a + 10 }],
  ['cost ⌈L⌉ + 10, 7 kW EV from 60 min', { costPct: (a) => a + 10, evFromMin: 60 }],
  ['cost ⌈L⌉ + 10, 7 kW EV from 90 min', { costPct: (a) => a + 10, evFromMin: 90 }],
  ['cost ⌈L⌉ + 10, 11.52 kW EV from 60 min', { costPct: (a) => a + 10, evKw: EV_MAX_KW, evFromMin: 60 }],
  ['cost ⌈L⌉ + 15, 11.52 kW EV from 60 min', { costPct: (a) => a + 15, evKw: EV_MAX_KW, evFromMin: 60 }],
];
const PIN_COST: Record<string, [number, number, number, number]> = {
  'cost ⌈L⌉ + 10, baseline': [0, 0, 0, 0],
  'cost ⌈L⌉ + 10, 7 kW EV from 60 min': [0, 0, 5, 5],
  'cost ⌈L⌉ + 10, 7 kW EV from 90 min': [0, 0, 0, 7],
  'cost ⌈L⌉ + 10, 11.52 kW EV from 60 min': [0, 0, 15, 27],
  'cost ⌈L⌉ + 15, 11.52 kW EV from 60 min': [0, 0, 15, 15],
};
/** (review 3) …the under nights the line-at-risk push reached, in PIN_COST's order. The push stops at the cost
 *  force-charge's own software stop (an OFF of ours); a late EV that takes the pool under after that stop is not
 *  pushed. The nights it does reach end with no OFF of ours (the panel's own ceiling stop). (review 4) Of the 59 of
 *  PIN_COST's 89 it does not reach, 49 end after the cost stop; 10 have no OFF of ours but are slow packs still rising
 *  at the close (7 floored with the 7 kW EV from 90 min, 3 floored with the 11.52 kW one): a load that slows the charge. */
const PIN_COST_PUSHED: Record<string, [number, number, number, number]> = {
  'cost ⌈L⌉ + 10, baseline': [0, 0, 0, 0],
  'cost ⌈L⌉ + 10, 7 kW EV from 60 min': [0, 0, 0, 0],
  'cost ⌈L⌉ + 10, 7 kW EV from 90 min': [0, 0, 0, 0],
  'cost ⌈L⌉ + 10, 11.52 kW EV from 60 min': [0, 0, 5, 16],
  'cost ⌈L⌉ + 15, 11.52 kW EV from 60 min': [0, 0, 5, 4],
};

/** (review 2) THE ON-READING LATCH — UNMEASURED on this plant (no per-slot readback ever showed a slot reading ON at
 *  its ceiling and not importing; 2026-09-18's "Charge Now still ON" is the add-on's record, not a readback). Per
 *  PREDICTED cell: [under, nights the line-at-risk push went] for [year rounded, year floored, high rounded, high
 *  floored], of 200 / 200 / 140 / 140. The re-ON keys on slots reading OFF, so nothing of ours switches these back on;
 *  the push reaches every night that closes under (pinned below), at least FORCE_CHARGE_LINE_AT_RISK_LEAD_MS before
 *  the close, and also goes on nights the remaining charge still carries. Matches the round-2 reviewer's emulation. */
const PIN_ON_LATCH: Record<string, Array<[number, number]>> = {
  '20 kWh predicted, 7 kW EV from 60 min': [[1, 6], [2, 8], [84, 140], [93, 140]],
  '20 kWh predicted, 7 kW EV from 90 min': [[8, 13], [9, 14], [137, 140], [139, 140]],
  '30 kWh predicted, 11 kW EV from 90 min': [[44, 55], [47, 58], [140, 140], [140, 140]],
  '30 kWh predicted, 11 kW EV from 120 min': [[31, 32], [32, 33], [140, 140], [140, 140]],
  'predicted exactly, 7 kW EV from 90 min': [[0, 0], [0, 0], [52, 70], [55, 73]],
  'predicted exactly, 11.52 kW EV from 90 min': [[8, 8], [8, 9], [105, 105], [105, 105]],
  'predicted exactly, 11.52 kW EV from 120 min': [[8, 8], [8, 9], [105, 105], [105, 105]],
  '36 kWh predicted, 11.52 kW EV from 90 min': [[65, 79], [72, 87], [140, 140], [140, 140]],
  '36 kWh predicted, 11.52 kW EV from 180 min': [[10, 10], [10, 11], [124, 132], [127, 135]],
  'pool 77 + 20 kWh predicted, 7 kW EV from 90 min': [[5, 12], [7, 16], [140, 140], [140, 140]],
  'all: standby, ON 5 min late, 3 min stale + 20 kWh predicted, 7 kW EV from 90 min': [[7, 11], [8, 12], [131, 140], [133, 140]],
};
/** (review 2) The line-at-risk push on the MEASURED (OFF-reading) latch, summed over every PREDICTED cell (3,740 nights),
 *  rounded and floored: none of those nights closes under the line (the re-ON carries them), so each push here is a
 *  warning on a night that still held — the cost of pushing while there is time to act. (review 3) 202 / 227 before the
 *  trend was judged only on readings after the last ON of ours had its readback grace, a flat pool only at or under ⌈L⌉,
 *  and no push at the re-ON's own cutoff instant: 392 of those pushes were a pack still importing (flat beside an EV, or
 *  "falling" against a reading from before the re-ON), 37 the cutoff instant. What is left is the 36 kWh / 11.52 kW from
 *  180 min cell at lines of 70-90%: a pool flat at ⌈L⌉ beside the EV. */
const PIN_REAL_PREDICTED_PUSHES = { round: 2, floor: 5 };
/** (review 3) Of the ON-reading latch's under nights (PIN_ON_LATCH), those whose once-a-night push came BEFORE the latch
 *  that lost the line (24 before the round-3 trend rules): one — 36 kWh predicted, 11.52 kW EV from 180 min, line 72.2,
 *  floored readings. The pool sat flat at ⌈L⌉ beside the EV 167 min before the close (a true warning then), recovered
 *  to the ceiling, latched 49 min before the close and closed at 72: the night's one push was already spent. */
const PIN_ON_LATCH_PUSHED_BEFORE_LATCH = 1;
/** (review 4) A RE-ON THAT NEVER TAKES EFFECT — UNMEASURED on this plant (the cloud accepts it; the slots still read OFF at
 *  its readback check). Per PREDICTED cell: [under, of them the nights the line-at-risk push reached] for [year rounded,
 *  year floored, high rounded, high floored], of 200 / 200 / 140 / 140. */
const PIN_REON_INERT: Record<string, Array<[number, number]>> = {
  '20 kWh predicted, 7 kW EV from 60 min': [[1, 0], [2, 0], [84, 21], [93, 32]],
  '20 kWh predicted, 7 kW EV from 90 min': [[8, 1], [9, 2], [137, 124], [139, 125]],
  '30 kWh predicted, 11 kW EV from 90 min': [[44, 17], [47, 20], [140, 140], [140, 140]],
  '30 kWh predicted, 11 kW EV from 120 min': [[31, 24], [32, 25], [140, 140], [140, 140]],
  'predicted exactly, 7 kW EV from 90 min': [[0, 0], [0, 0], [52, 31], [55, 34]],
  'predicted exactly, 11.52 kW EV from 90 min': [[8, 5], [8, 6], [105, 104], [105, 105]],
  'predicted exactly, 11.52 kW EV from 120 min': [[8, 6], [8, 6], [105, 104], [105, 104]],
  '36 kWh predicted, 11.52 kW EV from 90 min': [[65, 22], [72, 22], [140, 140], [140, 140]],
  '36 kWh predicted, 11.52 kW EV from 180 min': [[10, 8], [10, 8], [124, 108], [127, 109]],
  'pool 77 + 20 kWh predicted, 7 kW EV from 90 min': [[5, 0], [7, 1], [140, 129], [140, 135]],
  'all: standby, ON 5 min late, 3 min stale + 20 kWh predicted, 7 kW EV from 90 min': [[7, 0], [8, 1], [131, 114], [133, 116]],
};
/** …summed, rounded and floored (year: 11 cells × 400 nights; lines of 70-90%: 11 × 280). Before review 4 the trend took a re-ON
 *  checked not applied as an ON of ours, and the push waited 25-35 min after it: 90 of the 390 year nights and 1,740 of the 2,615
 *  at lines of 70-90%. (Fix8 review 1) The push is judged on the check's own tick (index.ts), so a night whose last check falls
 *  on the last tick before the 20-min lead is pushed there: 174 and 2,335 (169 and 2,308 with that tick not judged:
 *  PIN_REON_INERT_BEFORE_CHECK_JUDGED). */
const PIN_REON_INERT_SUM = { year: { n: 4400, under: 390, reached: 174 }, high: { n: 3080, under: 2615, reached: 2335 } };
/** (Fix8 review 1) …the same nights with the check's own tick not judged (4ace3a1e's index.ts): the under nights reached. */
const PIN_REON_INERT_BEFORE_CHECK_JUDGED = { year: 169, high: 2308 };
/** (Fix8 review 1) The 496 nights under the push does not reach: 471 have their last check at or inside the push's 20-min lead (no
 *  push is due there); 25 have it on the last tick before the re-ON's cutoff with a re-ON left — the re-ON due there holds the push,
 *  the check took the tick, and the next tick is the cutoff (no re-ON) and the lead (no push): a residual, stated. */
const PIN_REON_INERT_UNREACHED = { lead: 471, cutoffReOn: 25, other: 0 };
/** …and its pushes on nights that still held (the 36 kWh / 11.52 kW from 180 min cell at lines of 70-90%, as on the latch as
 *  measured). */
const PIN_REON_INERT_HELD_PUSHES = 6;
/** (review 5) Summed over every PREDICTED cell (7,480 nights, rounded and floored, year and 70-90% lines): the nights under,
 *  the under nights the line-at-risk push reached, the pushes on nights that held, the shape logs, the 'reOnHeld' and
 *  'reOnRefused' pushes. All four are unmeasured on this plant; each pins that the push and the shape log wait out an ON
 *  that works, wherever it came from.
 *  - reOnLate: none under. 88 of its 108 pushes on nights that held are a pool flat at ⌈L⌉ beside the EV with Charge Now ON,
 *    on a reading 15 min or more after the late apply (the measured latch's 7, on a pool the 16-min delay left lower).
 *    (Fix8 review 1) The other 20 go on the second re-ON's check, its own tick (index.ts judges it now), a minute before that
 *    re-ON takes effect: "has not taken effect" is true when sent. Read past the "not applied" re-ON with no wait (review 4):
 *    2,869 pushes on held nights, 3,271 shape logs.
 *  - reOnGlitch: none under; the measured latch's 7 pushes (PIN_REAL_PREDICTED_PUSHES) and (Fix8 review 1) 3 on the check's
 *    own all-OFF reading — 99 and 101 shape logs before.
 *  - reOnPerson: the person's ON 5 min after the push carries 1,026 of reOnInert's 3,005 nights under (927 with the check's
 *    tick not judged: a push a minute sooner leaves the person's ON a minute more); 1,483 of the 1,979 left are reached, as
 *    reOnInert's. The shape log fired on 2,476 of the 2,483 pushed nights before.
 *  - reOnLimited: every night under reached. 356 pushes are 'reOnRefused' — a hand-back 22-35 min before the close, whose
 *    retry would fall inside the re-ON's 20-min cutoff (236 of those nights still held on their margin) — and none
 *    'reOnHeld' inside a retry's spacing (3,256 before); the other 92 on held nights are reOnLate's kind (flat at ⌈L⌉
 *    beside an 11 kW or larger EV). Its re-ONs are stamped on their tick's own minute: PIN_REVIEW6 stamps them later.
 *    (review 8) 404 'reOnRefused', every one on the hand-back's own tick: +18 handed back 21 min out (the last tick before the
 *    cutoff, no push before), +30 handed back 36 min out (the retry's tick, 21 min out, within a tick of the cutoff: pushed,
 *    then retried), each on a night that held (held 328 → 376). */
const PIN_REVIEW5 = {
  reOnLate: { under: 0, reached: 0, held: 108, shapes: 0, heldCause: 0, refused: 0 },
  reOnGlitch: { under: 0, reached: 0, held: 10, shapes: 0, heldCause: 0, refused: 0 },
  reOnPerson: { under: 1979, reached: 1483, held: 1032, shapes: 0, heldCause: 0, refused: 0 },
  reOnLimited: { under: 121, reached: 121, held: 376, shapes: 0, heldCause: 0, refused: 404 },
};
/** (review 6) Summed over every PREDICTED cell (7,480 nights each, rounded and floored, year and 70-90% lines), as PIN_REVIEW5
 *  plus: `handBacks`, `lost` (neither the retry nor a push, a tick left before the lead), `lastTick` (handed back on the last
 *  tick before the re-ON's cutoff: the next tick is past it and the push's lead — none of those nights closes under),
 *  `refusedRetried`, and the person's ON the panel then stops. All unmeasured on this plant.
 *  - reOnLimited with each re-ON stamped 2 s after its tick (index.ts stamps Date.now() after the writes): the retry is the
 *    16th tick after the hand-back's, so a hand-back 36 min out has none (the 16th tick is the cutoff instant): 30 such
 *    nights, 25 of them under (with the stamp on its tick they got the retry and held). eed0363a held their push for a retry
 *    that never came — 30 hand-backs lost, 25 of the 146 under never reached; now 386 'reOnRefused' pushes (22-36 min out)
 *    and every night under reached. The other 187 pushes on held nights are reOnLate's kind (flat at ⌈L⌉ beside an 11 kW or
 *    larger EV, 26-36 min after the retry; 92 with the stamp on its tick).
 *  - …with the ticks 30 s off the minute too: the same — eed0363a lost 31, 22 of the 155 under never reached.
 *  - (review 8) with the full tick of margin and the push on the hand-back's own tick: 429 'reOnRefused' (431 off the minute),
 *    every one on that tick — +18 (17) handed back on the last tick before the cutoff, which had neither (`lastTick`, now 0),
 *    and +25 (20) whose retry's tick falls within a tick of the cutoff, pushed and then retried (`refusedRetried`), all on
 *    nights that held (held 428 → 471, 426 → 463). Of the 429 (431), 374 (380) are worded "its next try would come after
 *    ~<cutoff>" (`refusedSure`: the stamp + 15 min at or past the cutoff, so no tick brings the retry) and 55 (51) "it may try
 *    once more", the 25 (20) retried among them; none so worded is followed by the retry (`sureRetried`).
 *  - reOnPerson: of the 2,508 nights a person's ON took effect (2,476 with the check's tick not judged), 4 reach the panel's
 *    ceiling before the close; each stop is on the record and named by the morning account. (Its re-ONs never take effect, so
 *    the recorded stop stays before them and the re-ON's own rule stamped 3 of these at eed0363a too; the round-6 reviewer's night — the stop re-stamped after a re-ON
 *    that took effect, then a person's ON — is lineForceChargeAtRisk.test.ts's.) */
const PIN_REVIEW6: Record<string, Record<string, number>> = {
  'reOnLimited, stamped 2 s after its tick': {
    under: 146, reached: 146, held: 471, shapes: 0, heldCause: 0, refused: 429, handBacks: 3278, lost: 0, lastTick: 0, refusedRetried: 25,
    refusedSure: 374, sureRetried: 0, personOn: 0, personStop: 0, stopStamped: 0, stopNamed: 0,
  },
  'reOnLimited, ticks 30 s off the minute, stamped 2 s after': {
    under: 155, reached: 155, held: 463, shapes: 0, heldCause: 0, refused: 431, handBacks: 3292, lost: 0, lastTick: 0, refusedRetried: 20,
    refusedSure: 380, sureRetried: 0, personOn: 0, personStop: 0, stopStamped: 0, stopNamed: 0,
  },
  reOnPerson: {
    under: 1979, reached: 1483, held: 1032, shapes: 0, heldCause: 0, refused: 0, handBacks: 0, lost: 0, lastTick: 0, refusedRetried: 0,
    refusedSure: 0, sureRetried: 0, personOn: 2508, personStop: 4, stopStamped: 4, stopNamed: 4,
  },
};
/** (review 2) …and on the KNOWN late-unpredicted-load cells: the under nights the push reached, in PIN_KNOWN's order. It needs
 *  the pool NOT RISING with at least 20 min left: a load that slows the charge without stopping it (7 kW from 120 min;
 *  an ON 5 min late with a 7 kW EV) still rises, short of the line, and is not pushed — a residual, pinned. */
const PIN_KNOWN_PUSHED: Record<string, [number, number, number, number]> = {
  'unpredicted 7 kW EV from 120 min': [0, 0, 0, 0],
  'unpredicted 11.52 kW EV from 60 min': [0, 1, 8, 18],
  'unpredicted 11.52 kW EV from 90 min': [69, 70, 83, 90],
  'unpredicted 11.52 kW EV from 120 min': [52, 58, 124, 123],
  'ON 5 min late × unpredicted 7 kW EV from 90 min': [0, 0, 0, 0],
  'pack at 0.85 of the rate × unpredicted 7 kW EV from 90 min': [0, 0, 2, 0],
};
// (review 3) 702 → 698 of the 989: three of the four were pushes at exactly the re-ON's cutoff instant (close − 20 min,
// the plant's minute ticks; finding 4), the fourth against a reading inside the first ON's readback grace.

