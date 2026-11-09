/**
 * ★★★ v1.204.0 — THE NIGHT PLAN'S SOLAR BASIS, SELECTED (index.ts recomputeNightChargePlan), and the words that say which.
 *
 * With the house Cores dark on the vendor cloud, the published band (the Cores' own solar meter) has no scored days and v1.203.0
 * plans the night cushion-only. The panel still measures each slot's solar; the worker's planning layer (analytics.ts
 * getPlanningForecast, panelPvBasis.ts) fits a planning band on that reading and judges it by a 7-day full-day energy balance as of
 * the evening E that owns the window. This module decides, from ONE device snapshot and the reports of one recompute:
 *
 *  (a) the PUBLISHED band, when it passes its own gate (nightChargeAdvisor.solarBasisGate) AND covers the Cores of every connected
 *      slot of the house panel: v1.203.0's plan, byte for byte (no field of this module is put on it);
 *  (b) else the PLANNING band, when the panel basis may be used tonight (a write mode, a fresh panel, the night not cancelled, the
 *      live overnight leg), its reports are as of E, its keys are the connected slots, its verdict passes, every connected slot
 *      resolves (G7), a pack capacity ratio is known (G8) and the planning band passes the same gate;
 *  (c) else the published band EXACTLY as v1.203.0 reads it — passed as REFUSED where it passed its gate without covering every
 *      connected slot (M2), so (c) is always v1.203.0's cushion-only plan where eligible, with its transient flag as computed.
 *
 * One reason per clause of (b), in a fixed precedence (L1): the mode, the panel, the cancel; then the TRANSIENT class (no planning
 * report yet, one built for another evening or another slot set, a planning band refused the way a start-up leaves it), which prints
 * no refusal and keeps the 22:30 deferral; then the verdict's own reason (the record, the capacity, the constants, the holds, a
 * restart, the count, staleness, the balance: panelPvBasis.upperCheck's precedence); then G7, G8 and the planning band's gate.
 *
 * EVENING OWNERSHIP (M1, L2). E is the site day of the evening decision that owns the window: the evening job's own day; for every
 * other recompute the day of the latch that planned this window, else the plan date that will own it (chargeWindows
 * planDateOwningCycle). The latch records the basis it chose: a recompute inside the latched window selects that basis when its report
 * is available, and keeps the previous served plan when it is not — never a fresh (c) inside a latched window. A latch with no basis
 * (written before v1.204.0, or an evening that reached no decision) reads as the published basis to its window's close.
 *
 * Slot keys ('<panelSn>#<n>') and serials are never printed: the words carry slot numbers and days only. PURE throughout.
 */
import type { UcChecks, UcReason, UcVerdict, SlotSource, UncountedCause } from './panelPvBasis.js';
import { addDaysYmd } from './siteTime.js';

export type PvBasisKind = 'panel' | 'mixed';
export type PvSource = SlotSource;

/** One reason per clause of selection (b): the verdict's own, and the selection's. Figures only; the words are below. */
export type PvBasisReason =
  | Exclude<UcReason, { code: 'night-reading' }>
  | (Extract<UcReason, { code: 'night-reading' }> & {
    /** The add-on's force-charge in that hour, from the armed record (the night ledger's ON/OFF stamps): index.ts adds it. */
    forceCharge?: 'on' | 'off' | 'unknown';
    /** The hour's site clock ("1:00 AM"): index.ts adds it. */
    hourClock?: string;
  })
  /** Every connected slot's Core covered E−1's daylight with its own meter: no slot takes the panel's readings. */
  | { code: 'not-needed'; day: string }
  /** The panel basis is made only in a write mode (supervised or auto). */
  | { code: 'advisory' }
  /** The panel's reading is stale (the 22:30 last resort on a stale reading). */
  | { code: 'stale-panel' }
  /** Tonight's write was cancelled. */
  | { code: 'cancelled' }
  /** G7: a connected slot neither its Core nor a checked panel reading covers. */
  | { code: 'slot-unresolved'; slot: number }
  /** G8: no pack capacity ratio is known for the pool. */
  | { code: 'no-capacity-ratio' }
  /** The planning band's own gate (solarBasisGate's words), refused persistently. */
  | { code: 'band'; blockedBy: string }
  /** Inside a window whose plan of record was decided without the panel's readings (the latch reads the published basis). */
  | { code: 'latched'; asOfDay: string };

/** What a plan carries of the selection (NightChargePlan.pvBasis*): set on every live overnight plan but the published band's (a). */
export interface PvBasisDecoration {
  /** 'panel' | 'mixed': planned on the planning band; null: not (the cushion-only plan, or no plan). */
  pvBasis: PvBasisKind | null;
  /** E. */
  pvBasisAsOfDay: string;
  /** Each connected slot's source (that of its E−1 daylight), slot numbers only; null with no verdict. */
  pvBasisSlots: Array<{ slot: number; source: PvSource }> | null;
  /** The verdict's figures; null with no verdict. */
  pvBasisChecks: UcChecks | null;
  /** Why the panel basis is not used tonight (figures only); null when it is, and on the transient class. */
  pvBasisRefusedBy: PvBasisReason | null;
  /** The transient class: no refusal is printed, and the evening job keeps the 22:30 deferral (eveningBasisDefers). */
  pvBasisTransient?: true;
  /** The sentence the rationale closes with ('' when none): the card shows it word for word. */
  pvBasisText: string;
}

/* ─── E and the latch (M1, L2) ─────────────────────────────────────────────────────────────── */

/** The basis an evening latched for its window (index.ts NightChargeLatch.pv). */
export interface PvBasisLatch {
  basis: 'published' | 'planning';
  /** E: the evening's own site day. */
  asOfDay: string;
  windowStartMs: number;
  windowEndMs: number;
}

/**
 * The latched basis that governs a recompute of `window` now, or null (a fresh selection). A latch written with a basis owns the
 * window it recorded until that window's close. A latch with none (written before v1.204.0, or an evening that reached no decision)
 * owns the window its evening planned — the plan date owning the window now, or the armed record's day for this window — and reads
 * as the published basis. PURE.
 */
export function latchedPvBasis(o: {
  lastNotifyDay: string | null;
  pv: PvBasisLatch | null | undefined;
  windowStartMs: number | null;
  windowEndMs: number | null;
  nowMs: number;
  /** chargeWindows.planDateOwningCycle for this window now. */
  planDate: string;
  /** The armed record: the plan date that armed it, and its window. */
  armed: { day: string | null; windowStartMs: number | null };
}): { basis: 'published' | 'planning'; asOfDay: string } | null {
  if (o.lastNotifyDay == null || o.windowStartMs == null || o.windowEndMs == null || !(o.nowMs < o.windowEndMs)) return null;
  if (o.pv != null) {
    return o.pv.windowStartMs === o.windowStartMs && o.pv.asOfDay === o.lastNotifyDay && o.nowMs < o.pv.windowEndMs
      ? { basis: o.pv.basis, asOfDay: o.pv.asOfDay } : null;
  }
  const owns = o.planDate === o.lastNotifyDay || (o.armed.day === o.lastNotifyDay && o.armed.windowStartMs === o.windowStartMs);
  return owns ? { basis: 'published', asOfDay: o.lastNotifyDay } : null;
}

/** E for a recompute (M1): the evening job's own day; else the latch's; else the plan date that will own the window. PURE. */
export function planAsOfDay(o: { arming: boolean; todayYmd: string; latched: { asOfDay: string } | null; planDate: string }): string {
  if (o.arming) return o.todayYmd;
  return o.latched?.asOfDay ?? o.planDate;
}

/* ─── the selection ─────────────────────────────────────────────────────────────────────────── */

/** A band's gate result (nightChargeAdvisor.solarBasisGate). */
export interface BandGate { basisComplete: boolean; basisBlockedBy: string | null; transient: boolean }

export interface PvSelectionInput {
  /** E. */
  asOfDay: string;
  /** May the panel basis be used tonight at all: a write mode, a fresh panel, the night not cancelled (the live overnight leg only:
   *  index.ts never asks for a shadow leg). */
  eligible: { writeMode: boolean; panelFresh: boolean; cancelled: boolean };
  /** The latched basis governing this recompute (latchedPvBasis), or null. */
  latched: 'published' | 'planning' | null;
  /** The published band: its gate, and the connected slots whose Core it does not cover (empty: it covers every one). */
  published: { gate: BandGate; uncoveredSlots: number[] };
  /** The planning band's report as of E, or null (none, a timeout, no planning layer). */
  planning: null | {
    asOfDay: string | null | undefined;
    keys: readonly string[];
    verdict: UcVerdict | null | undefined;
    gate: BandGate;
  };
  /** The planning rollup's report is as of E. */
  planningRollupOk: boolean;
  /** The house panel's connected slot keys now, ascending by slot. */
  connectedKeys: readonly string[];
  /** G8: a pack capacity ratio is known (nightChargeAdvisor.cushionRatioKnown). */
  ratioKnown: boolean;
}

export interface PvSelection {
  /** Which band sizes the plan; 'keep-previous': inside a latched planning window with its report unavailable (L2). */
  use: 'published' | 'planning' | 'keep-previous';
  /** (a): the published band passed and covers every connected slot. Nothing of this module is put on that plan. */
  published: boolean;
  /** M2: the published band passed its gate without covering every connected slot — passed to the planner as refused, with these
   *  words. Null otherwise. */
  bandCoverageRefusedBy: string | null;
  /** (b) refused: why (null when used, on (a), and on the transient class). */
  reason: PvBasisReason | null;
  transient: boolean;
  /** The planning verdict, when one was read. */
  verdict: UcVerdict | null;
}

type BEval = { ok: true } | { ok: false; transient: true } | { ok: false; transient: false; reason: PvBasisReason };

/** Selection (b)'s clauses, in the fixed precedence (L1). PURE. */
export function planningClauses(i: PvSelectionInput): BEval {
  if (!i.eligible.writeMode) return { ok: false, transient: false, reason: { code: 'advisory' } };
  if (!i.eligible.panelFresh) return { ok: false, transient: false, reason: { code: 'stale-panel' } };
  if (i.eligible.cancelled) return { ok: false, transient: false, reason: { code: 'cancelled' } };
  const p = i.planning;
  // TRANSIENT: no report yet (a start-up, a timeout), one built for another evening, or for another slot set (the report predates
  // a slot change: the next one is rebuilt for the slots connected now).
  if (p == null || p.asOfDay !== i.asOfDay || p.verdict == null || !i.planningRollupOk) return { ok: false, transient: true };
  if (p.keys.join(',') !== i.connectedKeys.join(',')) return { ok: false, transient: true };
  const v = p.verdict;
  if (v.asOfDay !== i.asOfDay) return { ok: false, transient: true };
  if (v.state === 'not-needed') return { ok: false, transient: false, reason: { code: 'not-needed', day: addDaysYmd(i.asOfDay, -1) } };
  if (v.state !== 'pass') {
    return v.reason != null
      ? { ok: false, transient: false, reason: v.reason as PvBasisReason }
      : { ok: false, transient: true };
  }
  const unresolved = v.sources.find((s) => s.source === 'none');
  if (unresolved) return { ok: false, transient: false, reason: { code: 'slot-unresolved', slot: unresolved.slot } };
  if (!i.ratioKnown) return { ok: false, transient: false, reason: { code: 'no-capacity-ratio' } };
  if (!p.gate.basisComplete) {
    return p.gate.transient
      ? { ok: false, transient: true }
      : { ok: false, transient: false, reason: { code: 'band', blockedBy: p.gate.basisBlockedBy ?? 'refused' } };
  }
  return { ok: true };
}

/** M2's words: the connected slots whose Core the published band leaves out. PURE. */
export function bandCoverageRefusalText(uncoveredSlots: readonly number[]): string {
  const s = [...uncoveredSlots].sort((a, b) => a - b);
  return `the Cores' solar band leaves out the Core${s.length === 1 ? '' : 's'} of slot${s.length === 1 ? '' : 's'} ${slotList(s)}`;
}

/** The selection (a)/(b)/(c), from one recompute's inputs. PURE. */
export function selectPvBasis(i: PvSelectionInput): PvSelection {
  const pubGate = i.published.gate.basisComplete;
  const covers = i.published.uncoveredSlots.length === 0;
  const bandCoverageRefusedBy = pubGate && !covers ? bandCoverageRefusalText(i.published.uncoveredSlots) : null;
  const verdict = i.planning?.verdict ?? null;
  const out = (use: PvSelection['use'], b: BEval | null, published = false): PvSelection => ({
    use, published, bandCoverageRefusedBy: use === 'published' && !published ? bandCoverageRefusedBy : null,
    reason: b != null && !b.ok && !b.transient ? b.reason : null,
    transient: b != null && !b.ok && b.transient,
    verdict: published ? null : verdict,
  });
  if (i.latched === 'planning') {
    const b = planningClauses(i);
    if (b.ok) return out('planning', b);
    // L2: the latched basis's report is unavailable — the previous served plan stands (never a fresh (c) inside a latched window).
    if (b.transient) return out('keep-previous', b);
    // A refusal the evening's verdict could not have made (the slots changed, the mode, the panel): the published deps, said so.
    if (pubGate && covers) return out('published', null, true);
    return out('published', b);
  }
  if (pubGate && covers) return out('published', null, true);
  if (i.latched === 'published') {
    const b = planningClauses(i);
    // The plan of record was decided without the panel's readings: a reading that would pass now is not taken, and says so.
    const r: BEval = b.ok || b.transient ? { ok: false, transient: false, reason: { code: 'latched', asOfDay: i.asOfDay } } : b;
    return out('published', r);
  }
  const b = planningClauses(i);
  if (b.ok) return out('planning', b);
  return out('published', b);
}

/* ─── the words ─────────────────────────────────────────────────────────────────────────────── */

export type Lang = 'en' | 'es';

/** "1", "1 and 3", "1, 2 and 3" (es: "1 y 3"). */
export function slotList(slots: readonly number[], lang: Lang = 'en'): string {
  const s = slots.map(String);
  if (s.length <= 1) return s.join('');
  return `${s.slice(0, -1).join(', ')} ${lang === 'es' ? 'y' : 'and'} ${s[s.length - 1]}`;
}

const f2 = (n: number): string => n.toFixed(2);
const kwh2 = (n: number): string => (Math.round(n * 100) / 100).toFixed(2);
/** A balance figure: four decimals, so a ratio a hair above the threshold never prints equal to it. */
const r4s = (n: number): string => n.toFixed(4);
/** A signed kWh figure with a true minus sign. */
const signedKwh = (n: number): string => `${n < 0 ? '−' : n > 0 ? '+' : ''}${kwh2(Math.abs(n))}`;

/** Why a day did not count, in words. PURE. */
export function uncountedCauseText(c: { day: string } & UncountedCause, lang: Lang = 'en'): string {
  const es = lang === 'es';
  switch (c.cause) {
    case 'no-record': return es ? 'no tiene registro de los Cores de las ranuras' : "has no record of the slots' Cores";
    case 'map': return es ? 'estuvo bajo otra asignación de Cores a ranuras' : 'was under another slot-to-Core map';
    case 'no-vendor-row': return es ? 'no tiene total diario en el registro propio del panel' : "has no daily total from the panel's own ledger";
    case 'vendor-mismatch': return es ? 'no coincidió con el total diario propio del panel' : "did not match the panel's own daily total";
    case 'night-reading': return es
      ? `tuvo una lectura de la ranura ${c.slot} de ${c.w.toFixed(1)} W sin sol`
      : `had a slot ${c.slot} reading of ${c.w.toFixed(1)} W with the sun down`;
    case 'core-day': return es ? `tuvo la ranura ${c.slot} con el medidor propio de su Core` : `had slot ${c.slot} on its Core's own meter`;
    case 'field-share': return es
      ? `tuvo lecturas de la ranura ${c.slot} en solo el ${Math.round(c.frac * 100)} % de sus horas de sol`
      : `had slot ${c.slot}'s readings on only ${Math.round(c.frac * 100)}% of its daylight hours`;
    case 'slot-incomplete':
      switch (c.what) {
        case 'pct': return es ? `le faltó el nivel de carga de la ranura ${c.slot} en alguna hora` : `had slot ${c.slot}'s charge level missing in some hour`;
        case 'meter': return es ? `le faltó el medidor de red de la ranura ${c.slot} en alguna hora` : `had slot ${c.slot}'s grid meter missing in some hour`;
        case 'coverage': return es ? `le faltó la lectura de la ranura ${c.slot} en alguna hora` : `had slot ${c.slot}'s reading missing in some hour`;
        case 'bridge': return es ? `tuvo la lectura de la ranura ${c.slot} sin verificar por el puente de energía` : `had slot ${c.slot}'s reading not checked by the energy bridge`;
        case 'frozen': return es
          ? `tuvo la lectura de la ranura ${c.slot} sin cambio durante ${c.frozenHours} h`
          : `had slot ${c.slot}'s reading unchanged for ${c.frozenHours} h`;
        case 'ac-charge': return es
          ? `tuvo la ranura ${c.slot} cargando de la red con sol, antes de una prueba nocturna`
          : `had slot ${c.slot} charging from the grid in daylight before a night proof`;
        case 'no-hours': return es ? `no tiene horas de la ranura ${c.slot}` : `had no hours for slot ${c.slot}`;
        default: return es ? `tuvo la ranura ${c.slot} incompleta` : `had slot ${c.slot} incomplete`;
      }
    case 'no-estimate': return es ? `no tiene estimación de balance para la ranura ${c.slot}` : `had no energy-balance estimate for slot ${c.slot}`;
    default: return es ? 'no contó' : 'did not count';
  }
}

/**
 * Why the panel's own solar readings are not used tonight, in words, from the reason's figures only (M3: no cause is asserted). Every
 * hold names the evening it is held through. PURE.
 */
export function pvBasisReasonText(r: PvBasisReason, lang: Lang = 'en'): string {
  const es = lang === 'es';
  switch (r.code) {
    case 'no-membership-record': return es
      ? 'el complemento no tiene registro de qué Core ocupa cada ranura del panel'
      : "the add-on has no record of which Core sits in each of the panel's slots";
    case 'no-capacity': return es ? `el panel no informa la capacidad de la ranura ${r.slot}` : `the panel reports no capacity for slot ${r.slot}`;
    case 'no-constants': return es
      ? `el Core de la ranura ${r.slot} no tiene constantes de balance medidas: necesitan ${r.needDays} días completos del propio medidor solar de ese Core en esa ranura (tiene ${r.days}) y ${r.needChargeHours} horas nocturnas de carga desde la red (tiene ${r.chargeHours})`
      : `slot ${r.slot}'s Core has no measured energy-balance constants: they need ${r.needDays} whole days of that Core's own solar meter in that slot (it has ${r.days}) and ${r.needChargeHours} night hours of grid charge (it has ${r.chargeHours})`;
    case 'overlap-hold': {
      const pct = ((r.ratio - 1) * 100).toFixed(1);
      return es
        ? `la lectura de la ranura ${r.slot} superó en un ${pct} % la cifra propia de su Core el ${r.day}; las lecturas quedan retenidas hasta la noche del ${r.lastHeldDay} inclusive`
        : `slot ${r.slot}'s reading ran ${pct}% above its Core's own figure on ${r.day}; the readings are held through the evening of ${r.lastHeldDay}`;
    }
    case 'night-reading': {
      const at = r.hourClock != null ? (es ? ` a las ${r.hourClock}` : ` at ${r.hourClock}`) : '';
      const fc = r.forceCharge === 'on'
        ? (es ? 'la carga forzada del complemento estaba activa en esa hora' : "the add-on's force-charge was on in that hour")
        : r.forceCharge === 'off'
          ? (es ? 'la carga forzada del complemento estaba inactiva en esa hora' : "the add-on's force-charge was off in that hour")
          : (es ? 'el estado de la carga forzada del complemento en esa hora no consta' : "the add-on's force-charge state in that hour is not on record");
      return es
        ? `la ranura ${r.slot} leyó ${r.w.toFixed(1)} W sin sol${at} del ${r.day} (su entrada de red en esa hora: ${kwh2(r.acInWh / 1000)} kWh; ${fc}); una lectura nocturna de más de 20 W no es solar, y las lecturas quedan retenidas hasta la noche del ${r.lastHeldDay} inclusive`
        : `slot ${r.slot} read ${r.w.toFixed(1)} W with the sun down${at} on ${r.day} (its grid input in that hour ${kwh2(r.acInWh / 1000)} kWh; ${fc}); a night reading above 20 W is not a solar reading, and the readings are held through the evening of ${r.lastHeldDay}`;
    }
    case 'vendor-mismatch': {
      const above = r.diffKwh > 0;
      return es
        ? `el ${r.day} las lecturas del panel sumaron ${kwh2(Math.abs(r.diffKwh))} kWh ${above ? 'por encima' : 'por debajo'} del total solar diario propio del panel (${kwh2(r.fieldKwh)} frente a ${kwh2(r.vendorKwh)} kWh); las lecturas quedan retenidas hasta la noche del ${r.lastHeldDay} inclusive`
        : `on ${r.day} the panel's readings summed ${kwh2(Math.abs(r.diffKwh))} kWh ${above ? 'above' : 'below'} the panel's own daily solar total (${kwh2(r.fieldKwh)} against ${kwh2(r.vendorKwh)} kWh); the readings are held through the evening of ${r.lastHeldDay}`;
    }
    case 'restart':
      if (r.kind === 'slot-set-changed') {
        return es
          ? `cambiaron las ranuras conectadas del panel; los días completos de lecturas vuelven a contar desde el ${r.day}`
          : `the panel's connected slots changed; whole days of panel readings count again from ${r.day}`;
      }
      return es
        ? `cambió el Core de ${r.slot != null ? `la ranura ${r.slot}` : 'una ranura'}; los días completos de lecturas vuelven a contar desde el ${r.day}`
        : `the Core in ${r.slot != null ? `slot ${r.slot}` : 'a slot'} changed; whole days of panel readings count again from ${r.day}`;
    case 'too-few-field-days': {
      const newest = [...r.uncounted].sort((a, b) => (a.day < b.day ? 1 : -1))[0];
      const why = newest != null
        ? (es ? `; el día más reciente sin contar, ${newest.day}, ${uncountedCauseText(newest, 'es')}` : `; the newest day not counted, ${newest.day}, ${uncountedCauseText(newest, 'en')}`)
        : '';
      if (r.n === 0) {
        return es
          ? `aún ninguno de los ${r.need} días completos de lecturas del panel que necesita el balance de energía${why}`
          : `none yet of the ${r.need} whole days of panel readings the energy balance needs${why}`;
      }
      return es
        ? `solo ${r.n} de los ${r.need} días completos de lecturas del panel que necesita el balance de energía (cuentan desde el ${r.firstFieldDay})${why}`
        : `only ${r.n} of the ${r.need} whole days of panel readings the energy balance needs (they count from ${r.firstFieldDay})${why}`;
    }
    case 'stale': return es
      ? `el día completo más reciente de lecturas del panel que la comprobación pudo contar es el ${r.newest}; necesita uno no anterior al ${r.minNewest}`
      : `the newest whole day of panel readings the check could count is ${r.newest}; it needs one no older than ${r.minNewest}`;
    case 'balance': {
      const day = r.daylightRatio != null
        ? (es ? `${r4s(r.daylightRatio)} solo en horas de sol; ` : `${r4s(r.daylightRatio)} on daylight hours alone; `) : '';
      return es
        ? `el balance de energía de 7 días leyó ${r4s(r.ratio)} en la semana hasta el ${r.windowEnd}, por encima de ${f2(r.threshold)} (${day}sus noches cerraron en ${signedKwh(r.nightResidualKwhPerNight)} kWh por noche frente a las constantes medidas); las lecturas no vuelven a usarse antes de que pasen todas las semanas que terminan en 7 días completos posteriores`
        : `the 7-day energy balance read ${r4s(r.ratio)} on the week to ${r.windowEnd}, above ${f2(r.threshold)} (${day}its nights closed at ${signedKwh(r.nightResidualKwhPerNight)} kWh a night against the measured constants); the readings are not used again before the weeks ending on 7 later whole days have all passed`;
    }
    case 'not-needed': return es
      ? `el Core de cada ranura conectada informó su propia solar el ${r.day}, así que ninguna ranura toma las lecturas del panel`
      : `every connected slot's Core reported its own solar on ${r.day}, so no slot takes the panel's readings`;
    case 'advisory': return es
      ? 'el complemento está en modo consultivo (un plan sobre las lecturas del panel solo se hace en un modo de escritura)'
      : 'the add-on is in advisory mode (a plan on the panel\'s readings is made only in a write mode)';
    case 'stale-panel': return es
      ? 'la lectura del panel está desactualizada (un plan sobre sus lecturas necesita una lectura reciente)'
      : "the panel's reading is stale (a plan on its readings needs a fresh one)";
    case 'cancelled': return es ? 'la escritura de esta noche se canceló' : "tonight's write was cancelled";
    case 'slot-unresolved': return es
      ? `la ranura ${r.slot} está conectada, pero ni su Core ni una lectura verificada del panel la cubren`
      : `slot ${r.slot} is connected but neither its Core nor a checked panel reading covers it`;
    case 'no-capacity-ratio': return es
      ? 'no se conoce ninguna relación de capacidad de las baterías (un plan sobre las lecturas del panel necesita una)'
      : 'no pack capacity ratio is known (a plan on the panel\'s readings needs one)';
    case 'band': return es ? `sobre las lecturas del panel: ${r.blockedBy}` : `on the panel's readings: ${r.blockedBy}`;
    case 'latched': return es
      ? `el plan de referencia de esta ventana se decidió el ${r.asOfDay} sin ellas`
      : `this window's plan of record was decided on ${r.asOfDay} without them`;
    default: return es ? 'rechazadas' : 'refused';
  }
}

/** The machine code of a reason, for HA's pv_basis_refused_by and the ledger's column. PURE. */
export function pvBasisReasonCode(r: PvBasisReason | null | undefined): string | null {
  return r == null ? null : r.code;
}

/** The sentence a refused night's rationale closes with (the cushion-only plan's, after v1.203.0's disclosure). PURE. */
export function pvBasisRefusedText(r: PvBasisReason, lang: Lang = 'en'): string {
  return lang === 'es'
    ? ` Las lecturas solares propias del panel no se usan esta noche: ${pvBasisReasonText(r, 'es')}.`
    : ` The panel's own solar readings are not used tonight: ${pvBasisReasonText(r, 'en')}.`;
}

/**
 * The sentence a plan on the PANEL-MEASURED basis closes with (panelPvBasisText): which slots take which solar (each slot's source is
 * that of its E−1 daylight, L7), the band's calibration and the window mix, the balance with its threshold, and what the runway alarm
 * reads. True in every state it can be printed in (panel, mixed). PURE.
 */
export function panelPvBasisText(o: {
  verdict: Pick<UcVerdict, 'asOfDay' | 'sources' | 'checks' | 'basis'>;
  calScoredDays: number;
  /** Days of the 30-day window with an admitted panel reading (PlanningForecast.planningAdmittedDays); null when unknown. */
  admittedDays: number | null;
}, lang: Lang = 'en'): string {
  const es = lang === 'es';
  const v = o.verdict;
  const yday = addDaysYmd(v.asOfDay, -1);
  const panel = v.sources.filter((s) => s.source === 'panel').map((s) => s.slot);
  const core = v.sources.filter((s) => s.source === 'core').map((s) => s.slot);
  const T = f2(v.checks.threshold);
  const ratio = v.checks.ratio != null ? r4s(v.checks.ratio) : null;
  const slotsText = es
    ? (core.length === 0
      ? `${panel.length === 1 ? 'la ranura' : 'las ranuras'} ${slotList(panel, 'es')} ${panel.length === 1 ? 'toma' : 'toman'} su solar de la lectura propia del panel sobre los cargadores de cada Core (sus Cores no informaron su propia solar el ${yday})`
      : `${core.length === 1 ? 'la ranura' : 'las ranuras'} ${slotList(core, 'es')} con la cifra propia de su Core; ${panel.length === 1 ? 'la ranura' : 'las ranuras'} ${slotList(panel, 'es')} con la lectura propia del panel sobre los cargadores de su Core (${panel.length === 1 ? 'su Core no informó' : 'sus Cores no informaron'} su propia solar el ${yday})`)
    : (core.length === 0
      ? `slot${panel.length === 1 ? '' : 's'} ${slotList(panel)} take${panel.length === 1 ? 's' : ''} ${panel.length === 1 ? 'its' : 'their'} solar from the panel's own reading of each Core's chargers (${panel.length === 1 ? 'its Core' : 'their Cores'} did not report ${panel.length === 1 ? 'its' : 'their'} own solar on ${yday})`
      : `slot${core.length === 1 ? '' : 's'} ${slotList(core)} on ${core.length === 1 ? "its Core's" : "their Cores'"} own figure; slot${panel.length === 1 ? '' : 's'} ${slotList(panel)} on the panel's own reading of ${panel.length === 1 ? "its Core's" : "their Cores'"} chargers (${panel.length === 1 ? 'its Core' : 'their Cores'} did not report ${panel.length === 1 ? 'its' : 'their'} own solar on ${yday})`);
  const mix = o.admittedDays != null
    ? (es ? ` (las lecturas del panel cubren ${o.admittedDays} de los últimos 30 días)` : ` (the panel's readings stand in on ${o.admittedDays} of the last 30 days)`)
    : '';
  const bal = ratio != null
    ? (es
      ? `, y el balance de energía de 7 días lee ${ratio} en la semana hasta el ${v.checks.newestFieldDay}: la solar del panel frente a lo que explican los flujos medidos de la propia planta en 7 días completos, con constantes medidas contra el propio medidor solar de cada Core (se rechaza por encima de ${T})`
      : `, and the 7-day energy balance reads ${ratio} on the week to ${v.checks.newestFieldDay}: the panel's solar against what the plant's own metered flows account for over 7 whole days, on constants measured against each Core's own solar meter (refused above ${T})`)
    : '';
  return es
    ? ` SOLAR DE LAS LECTURAS DEL PANEL: ${slotsText}; la banda está calibrada en ${o.calScoredDays} días puntuados${mix}${bal}. La alarma de autonomía no lee estas lecturas: solo cuenta la solar de los Cores que informan la suya.`
    : ` SOLAR FROM THE PANEL'S READINGS: ${slotsText}; the band is calibrated on ${o.calScoredDays} scored days${mix}${bal}. The runway alarm does not read these readings: it counts only the solar of Cores that report their own.`;
}

/** The evening push's short basis sentence. PURE. */
export function pvBasisPushText(d: Pick<PvBasisDecoration, 'pvBasis' | 'pvBasisChecks' | 'pvBasisRefusedBy'>, lang: Lang = 'en'): string {
  const es = lang === 'es';
  if (d.pvBasis != null) {
    const c = d.pvBasisChecks;
    const fig = c?.ratio != null ? (es ? ` (balance de energía de 7 días ${r4s(c.ratio)}, se rechaza por encima de ${f2(c.threshold)})` : ` (7-day energy balance ${r4s(c.ratio)}, refused above ${f2(c.threshold)})`) : '';
    return es ? ` Solar de las lecturas del panel${fig}.` : ` Solar from the panel's readings${fig}.`;
  }
  if (d.pvBasisRefusedBy != null) {
    return es ? ` Solar del panel no usada: ${pvBasisReasonText(d.pvBasisRefusedBy, 'es')}.` : ` Panel solar not used: ${pvBasisReasonText(d.pvBasisRefusedBy, 'en')}.`;
  }
  return '';
}

/**
 * What a plan carries of the selection (null on (a) and on a shadow leg: nothing is put on those). The sentence: the accepted text on
 * a plan sized on the planning band; the refused sentence on a cushion-only plan; none on a refused plan (its basisBlockedBy carries
 * the reason: nightChargeAdvisor's panelBasisRefusal) and none on the transient class. PURE.
 */
export function pvBasisDecoration(o: {
  sel: PvSelection;
  asOfDay: string;
  /** The plan sized: basisComplete with requiredExtraKwh set, and whether it is a cushion-only plan. */
  plan: { sized: boolean; cushionOnly: boolean };
  /** The planning band's calibration (when (b) was used). */
  calScoredDays: number;
  admittedDays: number | null;
}): PvBasisDecoration | null {
  const { sel } = o;
  if (sel.use === 'keep-previous' || sel.published) return null;
  const v = sel.verdict;
  const base = {
    pvBasisAsOfDay: o.asOfDay,
    pvBasisSlots: v != null && v.asOfDay === o.asOfDay ? v.sources.map((s) => ({ slot: s.slot, source: s.source })) : null,
    pvBasisChecks: v != null && v.asOfDay === o.asOfDay ? v.checks : null,
  };
  if (sel.use === 'planning' && v != null) {
    const basis: PvBasisKind = v.basis === 'mixed' ? 'mixed' : 'panel';
    return {
      ...base, pvBasis: basis, pvBasisRefusedBy: null,
      pvBasisText: o.plan.sized ? panelPvBasisText({ verdict: v, calScoredDays: o.calScoredDays, admittedDays: o.admittedDays }) : '',
    };
  }
  if (sel.transient) return { ...base, pvBasis: null, pvBasisRefusedBy: null, pvBasisTransient: true, pvBasisText: '' };
  const r = sel.reason;
  return {
    ...base, pvBasis: null, pvBasisRefusedBy: r,
    pvBasisText: r != null && o.plan.cushionOnly && o.plan.sized ? pvBasisRefusedText(r) : '',
  };
}

/** The plan with its selection put on it: the fields, and the sentence closing its rationale. Null ⇒ the plan as it is. PURE. */
export function withPvBasis<P extends { rationale: string }>(plan: P, d: PvBasisDecoration | null): P {
  if (d == null) return plan;
  return {
    ...plan,
    rationale: `${plan.rationale}${d.pvBasisText}`,
    pvBasis: d.pvBasis,
    pvBasisAsOfDay: d.pvBasisAsOfDay,
    pvBasisSlots: d.pvBasisSlots,
    pvBasisChecks: d.pvBasisChecks,
    pvBasisRefusedBy: d.pvBasisRefusedBy,
    ...(d.pvBasisTransient ? { pvBasisTransient: true as const } : {}),
    pvBasisText: d.pvBasisText,
  };
}
