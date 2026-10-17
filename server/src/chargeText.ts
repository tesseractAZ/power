/**
 * chargeText.ts — the day-aware words of a charge cycle (plan §5, R5). PURE: every clock is an
 * argument; nothing here sends, speaks or reads a file.
 *
 * THE FORMATTER. Every time a mid-day text states is read from the leg's resolved window — the
 * tariff's, never a literal — and named from the moment the text is written: "tonight" for a window
 * that opens this evening or in the small hours after it, "today" and "tomorrow" by the Phoenix
 * calendar, the weekday beyond. The on-peak period is named by its span ("4–7pm"), from the tariff.
 *
 * THE TEXTS. The winter mid-day cycle's 21:30 push and spoken notice (one or two legs), its morning
 * refresh push, its summary at the restore, and its critical page for a restore that did not read
 * back. The overnight cycle's words are notify.ts's and nightChargeActuator.ts's, unchanged: an
 * overnight-only cycle never reaches a builder here (chargeAnnounce.ts routes by the leg's window
 * kind, and the golden test holds the overnight words byte-identical).
 *
 * Every text states the charge the plan EXPECTS (statedBuyKwh) and the level the write drives the
 * pool to; the islanded worst case the plan is sized on appears only on the push's labelled
 * sizing-basis line, never in a title, a headline or speech. The spoken notice (English, then the
 * Spanish second pass) stays within MAX_SPOKEN_ADVISORY_CHARS in every shape (middaySpokenNotice
 * drops the least-needed words first, never the level, the cancel time or the cushion clause).
 *
 * Until the mid-day switch (R6) nothing here is sent or spoken: the shadow (middayShadow.ts) logs
 * what the evening and the refresh would say, and the live paths that would send the rest are
 * routed here only for a super off-peak leg, which nothing arms.
 */
import type { NotifyMessage } from './notify.js';
import type { ForceChargeNightOutcome } from './nightForceCharge.js';
import { MAX_SPOKEN_ADVISORY_CHARS, NO_CHARGE_EXPECTED_KWH, revertRetryText } from './nightChargeActuator.js';

const TZ = 'America/Phoenix';

/* ── the formatter ────────────────────────────────────────────────────────── */

interface PhxParts {
  ymd: string;
  weekday: string;
  weekdayShort: string;
  hour: number;
  minute: number;
}

/** The Phoenix calendar date, weekday and clock of an instant. PURE. */
export function phxParts(ms: number): PhxParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'long', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '';
  const weekday = get('weekday');
  return {
    ymd: `${get('year')}-${get('month')}-${get('day')}`,
    weekday, weekdayShort: weekday.slice(0, 3), hour: Number(get('hour')), minute: Number(get('minute')),
  };
}

/** "10am", "3pm", "12am", "9:30am" — the push's compact clock. PURE. */
export function phxShortClock(ms: number): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true,
  }).formatToParts(new Date(ms));
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '';
  const minute = get('minute');
  return `${get('hour')}${minute === '' || minute === '00' ? '' : `:${minute}`}${get('dayPeriod').toLowerCase()}`;
}

/** "10:00 AM", "9:30 AM" — the push's full clock (a deadline, a restore time). PURE. */
export function phxClock(ms: number): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }).formatToParts(new Date(ms));
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '';
  const dp = get('dayPeriod');
  return `${get('hour')}:${get('minute')}${dp ? ' ' + dp : ''}`;
}

/** "10 AM", "9:30 AM" — the spoken clock (no ":00"). PURE. */
export function phxSpokenClock(ms: number): string {
  const p = phxParts(ms);
  const h12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
  return `${h12}${p.minute === 0 ? '' : `:${String(p.minute).padStart(2, '0')}`} ${p.hour < 12 ? 'AM' : 'PM'}`;
}

/** "10am–3pm", "11pm–5am". PURE. */
export function spanText(startMs: number, endMs: number): string {
  return `${phxShortClock(startMs)}–${phxShortClock(endMs)}`;
}

/** The on-peak span, its meridiem said once when both ends share it: "4–7pm". PURE. */
export function onPeakSpanText(startMs: number, endMs: number): string {
  const a = phxShortClock(startMs);
  const b = phxShortClock(endMs);
  const am = (s: string): string => s.slice(-2);
  return am(a) === am(b) ? `${a.slice(0, -2)}–${b}` : `${a}–${b}`;
}

/** Which day a window is, named from `nowMs`. */
export type DayWord = 'tonight' | 'today' | 'tomorrow' | { weekday: string };

const ymdNext = (ymd: string): string => {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + 1));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
};

/**
 * The day an instant falls on, as a text written at `nowMs` names it (Phoenix calendar). PURE.
 *  - the same date: 'tonight' from 6 PM, else 'today';
 *  - the next date: 'tonight' before 6 AM when written in the evening or the afternoon (the small
 *    hours after this evening: the overnight window that opens at midnight), else 'tomorrow';
 *  - any other date: its weekday.
 */
export function dayWord(ms: number, nowMs: number): DayWord {
  const t = phxParts(ms);
  const n = phxParts(nowMs);
  if (t.ymd === n.ymd) return t.hour >= 18 ? 'tonight' : 'today';
  if (t.ymd === ymdNext(n.ymd)) return t.hour < 6 && n.hour >= 12 ? 'tonight' : 'tomorrow';
  return { weekday: t.weekday };
}

const WEEKDAY_ES: Readonly<Record<string, string>> = Object.freeze({
  Sunday: 'domingo', Monday: 'lunes', Tuesday: 'martes', Wednesday: 'miércoles',
  Thursday: 'jueves', Friday: 'viernes', Saturday: 'sábado',
});

/** The English day word, lower case ("tomorrow", "Monday"). */
export function dayText(w: DayWord): string {
  return typeof w === 'string' ? w : w.weekday;
}
/** The English day word, capitalised to open a sentence. */
export function dayTextCap(w: DayWord): string {
  const s = dayText(w);
  return s.charAt(0).toUpperCase() + s.slice(1);
}
/** The Spanish day word ("esta noche", "hoy", "mañana", "el lunes"). */
export function dayTextEs(w: DayWord): string {
  if (w === 'tonight') return 'esta noche';
  if (w === 'today') return 'hoy';
  if (w === 'tomorrow') return 'mañana';
  return `el ${WEEKDAY_ES[w.weekday] ?? w.weekday}`;
}
/** "de mañana", "de hoy", "de esta noche", "del lunes" — the day after a Spanish clock. */
export function deDayEs(w: DayWord): string {
  return typeof w === 'string' ? `de ${dayTextEs(w)}` : `del ${WEEKDAY_ES[w.weekday] ?? w.weekday}`;
}
/** The Spanish day word, capitalised. */
export function dayTextEsCap(w: DayWord): string {
  const s = dayTextEs(w);
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** "tomorrow 10am–3pm" — a window named from `nowMs`. PURE. */
export function windowText(startMs: number, endMs: number, nowMs: number): string {
  return `${dayText(dayWord(startMs, nowMs))} ${spanText(startMs, endMs)}`;
}

/** The Spanish article for a spoken hour: "la 1 PM", "las 10 AM". */
const esHourArticle = (ms: number): string => (phxParts(ms).hour % 12 === 1 ? 'la' : 'las');
/** "de las 10 AM a las 3 PM". */
const spanSpokenEs = (a: number, b: number): string =>
  `de ${esHourArticle(a)} ${phxSpokenClock(a)} a ${esHourArticle(b)} ${phxSpokenClock(b)}`;

/** A whole kWh figure as a push states an expected charge: "about 34 kWh", "under 1 kWh". */
function kwhPhrase(kwh: number): string {
  const r = Math.round(kwh);
  return kwh < 1 ? 'under 1 kWh' : `about ${r} kWh`;
}

/** A whole percentage, "~90%". */
const pctText = (v: number): string => `~${Math.round(v * 10) / 10}%`;

/* ── the legs a mid-day text names ────────────────────────────────────────── */

/** The 10:00–15:00 cost leg as the evening announces it. */
export interface MiddayCostText {
  windowStartMs: number;
  windowEndMs: number;
  /** The level the write drives the pool to (nightChargeAdvisor.chargeLevelPct). */
  levelPct: number | null;
  /** The reserve the 10:00 write sets (T_mid). */
  reservePct: number | null;
  /** The expected draw (statedBuyKwh); null ⇒ no energy figure. */
  expectedKwh: number | null;
  /** The worst case the plan is sized on — the labelled sizing basis only. */
  buyKwh: number | null;
  /** The window closes before the level is reached (chargeIsWindowBound). */
  toward: boolean;
  /** Charge Now rides the leg: switched on just in time to reach `levelPct`. */
  forceCharge: boolean;
  /** The plan calls for a charge (its worst case reaches the minimum buy). */
  charges: boolean;
  basisComplete: boolean;
  cushionShortfall: boolean;
}

/** The overnight outage-backup leg as the evening announces it (reserve only). */
export interface MiddayBackupText {
  windowStartMs: number;
  windowEndMs: number;
  reservePct: number | null;
  expectedKwh: number | null;
  buyKwh: number | null;
  cushionShortfall: boolean;
}

/** What the evening's mid-day notice is told. */
export interface MiddayAnnounceInput {
  /** When the notice is written (the evening job, ~21:30). */
  nowMs: number;
  /** The write mode: 'advisory' writes nothing; 'supervised' and 'auto' arm. */
  mode: 'advisory' | 'supervised' | 'auto';
  cost: MiddayCostText;
  /** The backup leg, when it ARMS (or would, in advisory mode); null otherwise. */
  backup: MiddayBackupText | null;
  /** The on-peak period after the cost window (its start and end), null when the tariff has none. */
  onPeak: { startMs: number; endMs: number | null } | null;
  /** When the cost leg is refreshed (its window open − 30 min). */
  refreshAtMs: number;
  /** When each leg's write fires — the cancel deadline (the window open − APPLY_LEAD_MS). */
  costApplyAtMs: number;
  backupApplyAtMs: number | null;
  /** When the cost leg's restore falls due (min(window close, on-peak − 1 h)). */
  costRestoreAtMs: number;
  /** A write mode refused the cycle: why (armCycle's words). The push then names no write. */
  refused: string | null;
}

const isHeld = (kwh: number | null): boolean => kwh != null && Number.isFinite(kwh) && kwh < NO_CHARGE_EXPECTED_KWH;

/** The backup's push line: "Tonight 11pm–5am, outage backup: reserve held at 50%, about 2 kWh
 *  expected; cancel it separately on the card before 11:00 PM." */
function backupPushLine(b: MiddayBackupText, applyAtMs: number | null, nowMs: number, armed: boolean): string {
  const what = isHeld(b.expectedKwh) ? ', no charge expected'
    : b.expectedKwh != null && Number.isFinite(b.expectedKwh) ? `, ${kwhPhrase(b.expectedKwh)} expected` : '';
  const reserve = b.reservePct != null ? `${Math.round(b.reservePct)}%` : '—';
  const cancel = armed && applyAtMs != null ? `; cancel it separately on the card before ${phxClock(applyAtMs)}` : '';
  return `${dayTextCap(dayWord(b.windowStartMs, nowMs))} ${spanText(b.windowStartMs, b.windowEndMs)}, outage backup: `
    + `reserve ${armed ? 'held' : 'hold recommended'} at ${reserve}${what}${cancel}.`;
}

/** The labelled sizing-basis line: the islanded worst case each leg is sized on. */
function sizingBasisLine(cost: MiddayCostText, backup: MiddayBackupText | null): string {
  const parts: string[] = [];
  if (cost.buyKwh != null && Number.isFinite(cost.buyKwh) && cost.charges) parts.push(`~${Math.round(cost.buyKwh * 10) / 10} kWh for the daytime charge`);
  if (backup?.buyKwh != null && Number.isFinite(backup.buyKwh)) parts.push(`~${Math.round(backup.buyKwh * 10) / 10} kWh for the outage backup`);
  return parts.length === 0 ? ''
    : ` Sizing basis (the islanded worst case the plan is sized on, not the expected charge): ${parts.join(', ')}.`;
}

/**
 * The 21:30 push for a winter mid-day cycle (plan §5). PURE.
 *   Title: "Charge plan: charging to ~90% tomorrow 10am–3pm, about 34 kWh"
 *   Body:  "Tomorrow (Thu) 10am–3pm, APS super off-peak: charging the backup pool to ~90%, about
 *           34 kWh of grid energy expected. The plan is refreshed with the morning solar forecast at
 *           9:30 AM; it can only lower or cancel this charge. SUPERVISED: at 10:00 AM the backup
 *           reserve is held at 50% and Charge Now switches on just in time; both are restored at
 *           3:00 PM, before the 4–7pm on-peak. Cancel from the charge card before 10:00 AM tomorrow."
 *   then the backup line (when it arms), the cushion note, and the labelled sizing-basis line.
 * Shapes: a charge; a reserve held with no charge expected; advisory (recommended, nothing armed);
 * refused (nothing armed, and why — and no outage backup tonight); a daytime hold (the backup line
 * alone, or nothing); no plan (an incomplete basis).
 */
export function buildMiddayPlanMessage(i: MiddayAnnounceInput): NotifyMessage {
  const base = { severity: 'info' as const, dedupId: 'night_charge_plan' };
  const c = i.cost;
  const now = i.nowMs;
  const span = spanText(c.windowStartMs, c.windowEndMs);
  const day = dayWord(c.windowStartMs, now);
  const when = `${dayText(day)} ${span}`;
  const lead = typeof day === 'string'
    ? `${dayTextCap(day)} (${phxParts(c.windowStartMs).weekdayShort}) ${span}, APS super off-peak`
    : `${dayTextCap(day)} ${span}, APS super off-peak`;
  const supervised = i.mode !== 'advisory' && i.refused == null;
  const shortNote = c.cushionShortfall || i.backup?.cushionShortfall
    ? ' NOTE: charge/pool limits prevent fully meeting the cushion — residual risk remains.' : '';
  const backupLine = i.backup != null ? ` ${backupPushLine(i.backup, i.backupApplyAtMs, now, supervised)}` : '';
  if (!c.basisComplete) {
    return {
      ...base,
      title: `Charge plan: no plan for ${when}`,
      body: `No charge plan for ${when} — the forecast/telemetry basis is incomplete, so nothing will be charged. `
        + '(This confirms the evening job ran; the reserve floor is unchanged.)',
    };
  }
  if (i.refused != null) {
    const write = i.mode === 'auto' ? 'the write' : 'the supervised write';
    return {
      ...base,
      title: `Charge plan: ${dayText(day)}'s ${span} charge NOT armed`,
      body: `The plan for ${when} calls for a ${isHeld(c.expectedKwh) ? 'reserve hold' : 'charge'}, but ${write} was not armed — ${i.refused}. `
        + `The add-on will not charge ${dayText(day)}${i.backup != null ? `, and there is no outage backup ${dayText(dayWord(i.backup.windowStartMs, now))} because ${i.refused}` : ''}.${shortNote}`,
    };
  }
  if (!c.charges) {
    if (i.backup == null) {
      return {
        ...base,
        title: `Charge plan: hold — no charge ${when}`,
        body: `No daytime charge is needed ${when}, and the outage backup is not needed tonight. Nothing will be charged.${shortNote}`,
      };
    }
    return {
      ...base,
      title: `Charge plan: outage backup ${windowText(i.backup.windowStartMs, i.backup.windowEndMs, now)}; no charge ${when}`,
      body: `No daytime charge is needed ${when}.${backupLine}${shortNote}${sizingBasisLine(c, i.backup)}`,
    };
  }
  const reserve = c.reservePct != null ? `${Math.round(c.reservePct)}%` : '—';
  const refresh = ` The plan is refreshed with the morning solar forecast at ${phxClock(i.refreshAtMs)}; it can only lower or cancel this charge.`;
  const restore = `${phxClock(i.costRestoreAtMs)}${i.onPeak != null && i.onPeak.endMs != null ? `, before the ${onPeakSpanText(i.onPeak.startMs, i.onPeak.endMs)} on-peak` : ''}`;
  const cancel = ` Cancel from the charge card before ${phxClock(i.costApplyAtMs)} ${dayText(dayWord(i.costApplyAtMs, now))}.`;
  if (isHeld(c.expectedKwh)) {
    const tail = supervised
      ? ` SUPERVISED: at ${phxClock(i.costApplyAtMs)} the backup reserve is held at ${reserve}; it is restored at ${restore}.${cancel}`
      : ' Advisory only — the add-on will NOT charge.';
    return {
      ...base,
      title: `Charge plan: ${supervised ? 'reserve held' : 'reserve hold recommended'} at ${reserve} ${when} — no charge expected`,
      body: `${lead}: ${supervised ? 'holding' : 'recommended: hold'} the backup reserve at ${reserve} as a floor; no charge is expected.`
        + `${refresh}${tail}${backupLine}${shortNote}${sizingBasisLine(c, i.backup)}`,
    };
  }
  const to = c.toward ? 'toward' : 'to';
  const level = c.levelPct != null ? pctText(c.levelPct) : '—';
  const figure = c.expectedKwh != null && Number.isFinite(c.expectedKwh) ? kwhPhrase(c.expectedKwh) : null;
  const fc = c.forceCharge
    ? ` and Charge Now switches on just in time; both are restored at ${restore}.`
    : `; it is restored at ${restore}.`;
  const tail = supervised
    ? ` SUPERVISED: at ${phxClock(i.costApplyAtMs)} the backup reserve is held at ${reserve}${fc}${cancel}`
    : ' Advisory only — the add-on will NOT charge.';
  return {
    ...base,
    title: `Charge plan: ${supervised ? `charging ${to} ${level}` : `charge ${to} ${level} recommended`} ${when}${figure ? `, ${figure}` : ''}`,
    body: `${lead}: ${supervised ? 'charging' : 'recommended: charge'} the backup pool ${to} ${level}`
      + (c.toward ? ', as far as the window can deliver' : '')
      + (figure ? `, ${figure} of grid energy expected.` : '.')
      + `${refresh}${tail}${backupLine}${shortNote}${sizingBasisLine(c, i.backup)}`,
  };
}

/* ── the spoken notice ────────────────────────────────────────────────────── */

/** The spoken energy figure: ", about 34 kilowatt hours" / ", unos 34 kilovatios hora". */
function spokenKwh(kwh: number | null): { en: string; es: string } {
  if (kwh == null || !Number.isFinite(kwh)) return { en: '', es: '' };
  const r = Math.round(kwh);
  if (kwh < 1) return { en: ', less than 1 kilowatt hour', es: ', menos de 1 kilovatio hora' };
  return r === 1
    ? { en: ', about 1 kilowatt hour', es: ', alrededor de 1 kilovatio hora' }
    : { en: `, about ${r} kilowatt hours`, es: `, unos ${r} kilovatios hora` };
}

/** A backup at or above this expected draw is spoken as a leg of its own (its window, level and
 *  energy, and its own cancel time); below it, one clause says the reserve is held overnight. */
export const BACKUP_SPOKEN_LEG_KWH = 5;

/** " at 50 percent" / " en el 50 por ciento" — a spoken level, or nothing when there is none: a
 *  placeholder ("—") is never spoken. */
const atPctEn = (v: number | null): string => (v != null ? ` at ${v} percent` : '');
const atPctEs = (v: number | null): string => (v != null ? ` en el ${v} por ciento` : '');

/**
 * The spoken 21:30 notice for a winter mid-day cycle, English and Spanish (plan §5). PURE.
 *   Cost leg only:   "Charge notice. Tomorrow from 10 AM to 3 PM, charging the backup pool to about 90
 *                     percent, about 34 kilowatt hours. Cancel on the Power panel before 10 AM tomorrow."
 *   Backup < 5 kWh:  the same, with "Tonight the reserve is held at 50 percent as outage backup."
 *   Backup ≥ 5 kWh:  "Charge notice. Tonight 11 PM to 5 AM, outage backup to about 50 percent, about 12
 *                     kilowatt hours. Tomorrow 10 AM to 3 PM, toward 90 percent, about 58 kilowatt hours.
 *                     Cancel on the Power panel by 11 PM, or by 10 AM for the daytime charge."
 * "toward" says a window-bound charge (it replaces the window clause in the two-leg shape). The
 * cushion clause is spoken whenever a leg cannot hold the cushion — the audible channel is never
 * quieter about residual risk than the push. Within MAX_SPOKEN_ADVISORY_CHARS always: a shape that
 * would run over drops, in order, the window clause, then the backup's energy figure (or says the
 * backup clause compactly), and the last shape — no energy figure, no window clause, every part a
 * clock, a day word or a whole percentage — is within the bound by construction; none drops a level,
 * a cancel time or the cushion clause. A figure there is not (no level, no reserve on record) is left
 * unsaid, never spoken as a placeholder; the level falls back to the reserve the write holds, as the
 * overnight notice's does. null when nothing is armed (advisory, refused, no plan): nothing is spoken.
 */
export function middaySpokenNotice(i: MiddayAnnounceInput): { en: string; es: string } | null {
  const c = i.cost;
  if (i.mode === 'advisory' || i.refused != null || !c.basisComplete) return null;
  const costArms = c.charges;
  const b = i.backup;
  if (!costArms && b == null) return null;
  const now = i.nowMs;
  const short = c.cushionShortfall || b?.cushionShortfall === true;
  const shortEn = short ? ' Outage cushion not fully met.' : '';
  const shortEs = short ? ' Margen de respaldo no cubierto por completo.' : '';
  const cDay = dayWord(c.windowStartMs, now);
  const cA = phxSpokenClock(c.windowStartMs);
  const cB = phxSpokenClock(c.windowEndMs);
  const cancelAt = phxSpokenClock(i.costApplyAtMs);
  const cancelDay = dayWord(i.costApplyAtMs, now);
  // The level the write drives the pool to; with none on record, the reserve it holds (the overnight
  // notice reads it the same way). Nothing is said for a figure there is not.
  const level = c.levelPct != null ? Math.round(c.levelPct) : c.reservePct != null ? Math.round(c.reservePct) : null;
  const reserve = c.reservePct != null ? Math.round(c.reservePct) : null;
  const held = isHeld(c.expectedKwh);
  const toEn = level != null ? ` ${c.toward ? 'toward' : 'to about'} ${level} percent` : '';
  const toEs = level != null ? ` ${c.toward ? 'rumbo al' : 'hasta cerca del'} ${level} por ciento` : '';
  const ck = spokenKwh(c.expectedKwh);
  const bReserve = b?.reservePct != null ? Math.round(b.reservePct) : null;
  const bDay = b != null ? dayWord(b.windowStartMs, now) : null;
  const bigBackup = b != null && b.expectedKwh != null && Number.isFinite(b.expectedKwh) && b.expectedKwh >= BACKUP_SPOKEN_LEG_KWH;

  /** The cost leg's sentence, opened by its day. */
  const costSentence = (windowClause: boolean): { en: string; es: string } => {
    if (held) {
      return {
        en: `${dayTextCap(cDay)} from ${cA} to ${cB}, the backup reserve is held${atPctEn(reserve)}; no charge is expected.`,
        es: `${dayTextEsCap(cDay)} ${spanSpokenEs(c.windowStartMs, c.windowEndMs)}, la reserva de respaldo se mantiene${atPctEs(reserve)}; no se espera ninguna carga.`,
      };
    }
    const w = windowClause && c.toward && level != null;
    return {
      en: `${dayTextCap(cDay)} from ${cA} to ${cB}, charging the backup pool${toEn}${ck.en}.`
        + (w ? ' The window may fall short of that level.' : ''),
      es: `${dayTextEsCap(cDay)} ${spanSpokenEs(c.windowStartMs, c.windowEndMs)}, se cargarán las baterías de respaldo${toEs}${ck.es}.`
        + (w ? ' La ventana puede quedarse corta.' : ''),
    };
  };
  const cancelCost = {
    en: ` Cancel on the Power panel before ${cancelAt} ${dayText(cancelDay)}.`,
    es: ` Cancele en el panel Power antes de ${esHourArticle(i.costApplyAtMs)} ${cancelAt} ${deDayEs(cancelDay)}.`,
  };

  const candidates: Array<{ en: string; es: string }> = [];
  if (b == null) {
    // The cost leg alone.
    for (const wc of [true, false]) {
      const s = costSentence(wc);
      candidates.push({ en: `Charge notice. ${s.en}${shortEn}${cancelCost.en}`, es: `Aviso de carga. ${s.es}${shortEs}${cancelCost.es}` });
    }
  } else if (!costArms) {
    // The backup alone (the daytime leg holds).
    const bk = spokenKwh(b.expectedKwh);
    const bApply = i.backupApplyAtMs ?? b.windowStartMs;
    for (const withKwh of [true, false]) {
      const k = withKwh && !isHeld(b.expectedKwh) ? bk : { en: '', es: '' };
      candidates.push({
        en: `Charge notice. ${dayTextCap(bDay!)} from ${phxSpokenClock(b.windowStartMs)} to ${phxSpokenClock(b.windowEndMs)}, outage backup: the reserve is held${atPctEn(bReserve)}${k.en}. `
          + `No daytime charge is needed ${dayText(cDay)}.${shortEn} Cancel on the Power panel before ${phxSpokenClock(bApply)}.`,
        es: `Aviso de carga. ${dayTextEsCap(bDay!)} ${spanSpokenEs(b.windowStartMs, b.windowEndMs)}, respaldo: la reserva se mantiene${atPctEs(bReserve)}${k.es}. `
          + `No se necesita carga de día ${dayTextEs(cDay)}.${shortEs} Cancele en el panel Power antes de ${esHourArticle(bApply)} ${phxSpokenClock(bApply)}.`,
      });
    }
  } else if (!bigBackup) {
    // The cost leg, with the backup as one clause (compact last).
    for (const [wc, compact] of [[true, false], [false, false], [false, true]] as const) {
      const s = costSentence(wc);
      const bEn = compact
        ? ` Outage backup ${dayText(bDay!)}: reserve ${bReserve != null ? `at ${bReserve} percent` : 'held'}.`
        : ` ${dayTextCap(bDay!)} the reserve is held${bReserve != null ? ` at ${bReserve} percent` : ''} as outage backup.`;
      const bEs = compact
        ? ` Respaldo ${dayTextEs(bDay!)}: reserva ${bReserve != null ? `al ${bReserve} por ciento` : 'mantenida'}.`
        : ` ${dayTextEsCap(bDay!)} la reserva se mantiene${bReserve != null ? ` en ${bReserve} por ciento` : ''} como respaldo.`;
      candidates.push({
        en: `Charge notice. ${s.en}${bEn}${shortEn}${cancelCost.en}`,
        es: `Aviso de carga. ${s.es}${bEs}${shortEs}${cancelCost.es}`,
      });
    }
  } else {
    // Both legs, each with its window: "toward" carries a window-bound charge.
    const bk = spokenKwh(b.expectedKwh);
    const bApply = i.backupApplyAtMs ?? b.windowStartMs;
    for (const withKwh of [true, false]) {
      const k = withKwh ? bk : { en: '', es: '' };
      const cEn = held
        ? `${dayTextCap(cDay)} ${cA} to ${cB}, reserve held${atPctEn(reserve)}, no charge expected.`
        : `${dayTextCap(cDay)} ${cA} to ${cB}${level != null ? `, ${c.toward ? 'toward' : 'to about'} ${level} percent` : ', charging'}${ck.en}.`;
      const cEs = held
        ? `${dayTextEsCap(cDay)} de ${cA} a ${cB}, reserva${atPctEs(reserve)}, sin carga prevista.`
        : `${dayTextEsCap(cDay)} de ${cA} a ${cB}${level != null ? `, ${c.toward ? 'hacia el' : 'hasta cerca del'} ${level} por ciento` : ', carga'}${ck.es}.`;
      candidates.push({
        en: `Charge notice. ${dayTextCap(bDay!)} ${phxSpokenClock(b.windowStartMs)} to ${phxSpokenClock(b.windowEndMs)}, outage backup${bReserve != null ? ` to about ${bReserve} percent` : ''}${k.en}. `
          + `${cEn}${shortEn} Cancel on the Power panel by ${phxSpokenClock(bApply)}, or by ${cancelAt} for the daytime charge.`,
        es: `Aviso de carga. ${dayTextEsCap(bDay!)} de ${phxSpokenClock(b.windowStartMs)} a ${phxSpokenClock(b.windowEndMs)}, respaldo${bReserve != null ? ` hasta cerca del ${bReserve} por ciento` : ''}${k.es}. `
          + `${cEs}${shortEs} Cancele en el panel Power antes de ${esHourArticle(bApply)} ${phxSpokenClock(bApply)}, o de ${esHourArticle(i.costApplyAtMs)} ${cancelAt} para la carga de día.`,
      });
    }
  }
  /** The last shape, within the bound by construction (no energy figure, no window clause, every
   *  part a clock, a day word or a whole percentage): the level, the cancel time and the cushion
   *  clause are still said. */
  const minimalNotice = (): { en: string; es: string } => {
    const costEn = held ? `reserve held${atPctEn(reserve)}` : level != null ? `${c.toward ? 'toward' : 'to about'} ${level} percent` : 'charging';
    const costEs = held ? `reserva${atPctEs(reserve)}` : level != null ? `${c.toward ? 'hacia el' : 'hasta cerca del'} ${level} por ciento` : 'carga';
    const bApply = b != null ? (i.backupApplyAtMs ?? b.windowStartMs) : null;
    const bEn = b == null ? '' : ` Outage backup ${dayText(bDay!)}${atPctEn(bReserve)}.`;
    const bEs = b == null ? '' : ` Respaldo ${dayTextEs(bDay!)}${atPctEs(bReserve)}.`;
    if (b != null && !costArms) {
      return {
        en: `Charge notice.${bEn}${shortEn} Cancel on the Power panel before ${phxSpokenClock(bApply!)}.`,
        es: `Aviso de carga.${bEs}${shortEs} Cancele en el panel Power antes de ${esHourArticle(bApply!)} ${phxSpokenClock(bApply!)}.`,
      };
    }
    const cancelEn = bigBackup
      ? ` Cancel on the Power panel by ${phxSpokenClock(bApply!)}, or by ${cancelAt} for the daytime charge.`
      : cancelCost.en;
    const cancelEs = bigBackup
      ? ` Cancele en el panel Power antes de ${esHourArticle(bApply!)} ${phxSpokenClock(bApply!)}, o de ${esHourArticle(i.costApplyAtMs)} ${cancelAt} para la carga de día.`
      : cancelCost.es;
    return {
      en: `Charge notice. ${dayTextCap(cDay)} ${cA} to ${cB}, ${costEn}.${bEn}${shortEn}${cancelEn}`,
      es: `Aviso de carga. ${dayTextEsCap(cDay)} de ${cA} a ${cB}, ${costEs}.${bEs}${shortEs}${cancelEs}`,
    };
  };
  candidates.push(minimalNotice());
  const fits = candidates.find((t) => t.en.length + t.es.length <= MAX_SPOKEN_ADVISORY_CHARS);
  return fits ?? candidates[candidates.length - 1];
}

/* ── the morning refresh push ─────────────────────────────────────────────── */

/** What the refresh push is told: the leg as announced, and what the refresh made of it. */
export interface MiddayRefreshText {
  nowMs: number;
  windowStartMs: number;
  windowEndMs: number;
  /** When the evening announced it. */
  announcedAtMs: number | null;
  disposition: 'unchanged' | 'lowered' | 'capped' | 'cancelled' | 'stood';
  announced: { levelPct: number | null; expectedKwh: number | null };
  refreshed: { levelPct: number | null; reservePct: number | null; expectedKwh: number | null };
  /** The level the re-plan asked for when it was capped (above the announced one). */
  neededLevelPct: number | null;
  /** The window's P50 PV, last evening and now, kWh (the reason a figure moved, when it did). */
  windowPvKwh: { announced: number | null; refreshed: number | null };
  /** The reserve the panel holds now (a cancel leaves it). */
  reservePct: number | null;
  /** The cancel deadline (the window open − APPLY_LEAD_MS). */
  applyAtMs: number;
  /** A live refresh would push (refreshLeg wouldPush). */
  wouldPush: boolean;
}

/**
 * The morning refresh's push (plan §3.4 step 5): a cancel, a changed written value, a cap, or an
 * expected-kWh move above 25% either way. Never spoken. null when the refresh pushes nothing. PURE.
 *   "Charge plan updated: still ~90% today 10am–3pm, now about 22 kWh (announced last night: about
 *    34 kWh) — the morning solar forecast for the window is higher (~14 kWh, was ~9 kWh). Cancel
 *    from the charge card before 10:00 AM."
 */
export function buildMiddayRefreshMessage(r: MiddayRefreshText): NotifyMessage | null {
  if (!r.wouldPush || r.disposition === 'stood') return null;
  const base = { severity: 'info' as const, dedupId: 'night_charge_plan' };
  const when = windowText(r.windowStartMs, r.windowEndMs, r.nowMs);
  const span = spanText(r.windowStartMs, r.windowEndMs);
  const whenAnnounced = r.announcedAtMs != null ? dayWord(r.announcedAtMs, r.nowMs) : null;
  const announcedWhen = whenAnnounced === 'today' || whenAnnounced === 'tonight' ? 'this evening'
    : whenAnnounced != null ? 'last night' : 'last evening';
  const cancel = ` Cancel from the charge card before ${phxClock(r.applyAtMs)}.`;
  if (r.disposition === 'cancelled') {
    return {
      ...base,
      title: `Charge plan updated: ${dayText(dayWord(r.windowStartMs, r.nowMs))}'s ${span} charge is cancelled`,
      body: `The morning re-plan needs no charge ${when}, so the charge announced ${announcedWhen} is cancelled: nothing will be written`
        + `${r.reservePct != null ? `, and the reserve stays at ${r.reservePct}%` : ''}.`,
    };
  }
  const aLevel = r.announced.levelPct != null ? pctText(r.announced.levelPct) : '—';
  if (r.disposition === 'capped') {
    return {
      ...base,
      title: `Charge plan updated: held at the announced ${aLevel} ${when}`,
      body: `The morning re-plan calls for more (${r.neededLevelPct != null ? pctText(r.neededLevelPct) : 'a higher level'}), but a refresh never raises an announced charge: `
        + `${when} stays at ${aLevel}.${cancel}`,
    };
  }
  const level = r.refreshed.levelPct != null ? pctText(r.refreshed.levelPct) : '—';
  const now = r.refreshed.expectedKwh != null && Number.isFinite(r.refreshed.expectedKwh)
    ? (isHeld(r.refreshed.expectedKwh) ? 'now no charge expected' : `now ${kwhPhrase(r.refreshed.expectedKwh)}`) : null;
  const was = r.announced.expectedKwh != null && Number.isFinite(r.announced.expectedKwh)
    ? ` (announced ${announcedWhen}: ${isHeld(r.announced.expectedKwh) ? 'no charge expected' : kwhPhrase(r.announced.expectedKwh)})` : '';
  const pvA = r.windowPvKwh.announced;
  const pvR = r.windowPvKwh.refreshed;
  const pv = pvA != null && pvR != null && Number.isFinite(pvA) && Number.isFinite(pvR) && Math.abs(pvR - pvA) >= 0.5
    ? ` — the morning solar forecast for the window is ${pvR > pvA ? 'higher' : 'lower'} (~${Math.round(pvR)} kWh, was ~${Math.round(pvA)} kWh)`
    : ' — re-planned on the morning solar forecast';
  if (r.disposition === 'lowered') {
    return {
      ...base,
      title: `Charge plan updated: now ${level} ${when}${now ? `, ${now.replace(/^now /, '')}` : ''}`,
      body: `Lowered to ${level} ${when} (announced ${announcedWhen}: ${aLevel})${now ? `, ${now}` : ''}${was}${pv}.`
        + `${r.refreshed.reservePct != null ? ` The reserve is held at ${r.refreshed.reservePct}% from the open.` : ''}${cancel}`,
    };
  }
  return {
    ...base,
    title: `Charge plan updated: still ${aLevel} ${when}${now ? `, ${now}` : ''}`,
    body: `Still ${aLevel} ${when}${now ? `, ${now}` : ''}${was}${pv}.${cancel}`,
  };
}

/* ── the summary at the restore ───────────────────────────────────────────── */

/** What the mid-day summary is told, from the leg's record at its restore. */
export interface MiddaySummaryText {
  windowStartMs: number;
  windowEndMs: number;
  targetPct: number | null;
  restorePct: number;
  /** When the restore was accepted. */
  restoredAtMs: number;
  expectedKwh: number | null;
  forceCharge: ForceChargeNightOutcome | null;
  /** When Charge Now was switched off, and why (nightForceCharge's off reason). */
  forceChargeOffAtMs: number | null;
  forceChargeOffReason: string | null;
  onPeak: { startMs: number; endMs: number | null } | null;
  ended: 'window' | 'cancelled' | 'gridLoss';
}

/**
 * The summary of a mid-day leg, sent when its reserve is restored (plan §5). PURE.
 *   "Charge (Thu 10am–3pm) completed: reserve held at 50%, Charge Now switched off at ~90% at 2:41 PM;
 *    the reserve was restored to 16% at 3:00 PM, before the 4–7pm on-peak."
 * The expected figure rides only an account of the legs it counts, as the overnight summary's does
 * (notify.buildNightChargeMorningSummary); a cancel or a grid-loss stop is not a completed charge.
 */
export function buildMiddayChargeSummary(o: MiddaySummaryText): NotifyMessage {
  const base = { severity: 'info' as const, dedupId: 'night_charge_actuation' };
  const label = `Charge (${phxParts(o.windowStartMs).weekdayShort} ${spanText(o.windowStartMs, o.windowEndMs)})`;
  const raised = `${o.targetPct ?? '—'}%`;
  if (o.ended !== 'window') {
    const cancelled = o.ended === 'cancelled';
    return {
      ...base,
      title: `${label}: ${cancelled ? 'cancelled' : 'stopped (grid lost)'} — reserve restored to ${o.restorePct}%`,
      body: `${label} ${cancelled ? 'was cancelled after the write' : 'stopped: the grid was lost during the window'}: `
        + `the reserve, held at ${raised}, is restored to ${o.restorePct}% and nothing more is charged today.`,
    };
  }
  const before = o.onPeak != null && o.onPeak.endMs != null ? `, before the ${onPeakSpanText(o.onPeak.startMs, o.onPeak.endMs)} on-peak` : '';
  const restored = `the reserve was restored to ${o.restorePct}% at ${phxClock(o.restoredAtMs)}${before}.`;
  const held = isHeld(o.expectedKwh);
  const fc: ForceChargeNightOutcome = o.forceCharge ?? { kind: 'none', expectedLeg: false };
  const figureFits = fc.kind === 'none' ? fc.expectedLeg === false : fc.kind === 'ran' && fc.expectedLeg === true;
  const figure = o.expectedKwh != null && Number.isFinite(o.expectedKwh) && !held && figureFits ? ` (${kwhPhrase(o.expectedKwh)} expected)` : '';
  const reserve = held ? `the reserve was held at ${raised} as a floor (no charge was expected)` : `reserve held at ${raised}`;
  let what: string;
  if (fc.kind === 'none') {
    what = `${reserve}${figure}; ${restored}`;
  } else {
    const stop = fc.stopPct != null && Number.isFinite(fc.stopPct) ? `~${Math.round(fc.stopPct * 10) / 10}%` : null;
    if (fc.kind === 'ran') {
      const off = o.forceChargeOffAtMs != null
        ? o.forceChargeOffReason === 'target' && stop
          ? `, and Charge Now switched off at ${stop} at ${phxClock(o.forceChargeOffAtMs)}`
          : `, and Charge Now ran${stop ? ` toward ${stop}` : ''} and switched off at ${phxClock(o.forceChargeOffAtMs)}`
        : `, and Charge Now ran${stop ? ` toward ${stop}` : ''}`;
      what = `${reserve}${off}${figure}; ${restored}`;
    } else {
      const failed = fc.kind === 'failed' && fc.partialSlots != null
        ? `was switched ON but did not take effect on slot(s) ${fc.partialSlots.join(', ')}`
        : 'was switched ON but did not take effect';
      what = `${reserve}; Charge Now${stop ? ` toward ${stop}` : ''} ${fc.kind === 'neverStarted' ? 'never started'
        : fc.kind === 'failed' ? failed : 'was switched ON but the panel never confirmed it'}; ${restored}`;
    }
  }
  return {
    ...base,
    title: `${label}: reserve restored to ${o.restorePct}%`,
    body: `${label} completed: ${what} Delivery vs plan scores in the ledger after the cycle ends.`,
  };
}

/* ── the critical page ────────────────────────────────────────────────────── */

/** What the mid-day critical page is told (nightChargeActuator.decideRevertDeadline's page). */
export interface MiddayRevertDeadlineText {
  windowStartMs: number;
  windowEndMs: number;
  stage: 'deadline' | 'onPeak';
  unknown: boolean;
  targetPct: number;
  restorePct: number | null;
  /** The on-peak start ("4:00 PM" is said from it); null when the leg has none on record. */
  onPeakStartMs: number | null;
  /** Charge Now was switched on and its OFF has not read back: the page asks for it too. */
  forceChargeOffOpen: boolean;
  /** A restore of ours will still be sent (nightChargeActuator.revertRetryPending): the push says
   *  the add-on keeps retrying only then. */
  retrying: boolean;
}

/**
 * The spoken critical for a mid-day restore that has not read back by its deadline, or by the
 * on-peak start (plan §5), English and the Spanish second pass. PURE.
 *   "Critical. The 10 AM to 3 PM charge could not be confirmed stopped, and on-peak pricing starts at
 *    4 PM. Set the backup reserve to 16 percent and switch Charge Now off in the EcoFlow app."
 * With no live reading it says the stop could not be confirmed; with our target read back it says the
 * reserve still reads it. Within MAX_SPOKEN_ADVISORY_CHARS.
 */
export function middayRevertDeadlineSpoken(o: MiddayRevertDeadlineText): { en: string; es: string } {
  const a = phxSpokenClock(o.windowStartMs);
  const b = phxSpokenClock(o.windowEndMs);
  const r = o.restorePct;
  const toEn = r != null ? `${r} percent` : 'its usual level';
  const toEs = r != null ? `al ${r} por ciento` : 'a su nivel habitual';
  const insteadEs = r != null ? `en lugar del ${r} por ciento` : 'en lugar de su nivel habitual';
  const fcEn = o.forceChargeOffOpen ? ' and switch Charge Now off' : '';
  const fcEs = o.forceChargeOffOpen ? ' y apague Charge Now' : '';
  const peak = o.onPeakStartMs != null ? phxSpokenClock(o.onPeakStartMs) : null;
  const span = `${a} to ${b}`;
  const spanEs = spanSpokenEs(o.windowStartMs, o.windowEndMs);
  // What to do, in full and then compact (the reserve, not "the backup reserve"): a shape that would
  // run over the bound is said in the compact form; the reserve to set and Charge Now never drop.
  const acts = [
    { en: ` Set the backup reserve to ${toEn}${fcEn} in the EcoFlow app.`, es: ` Ajuste la reserva de respaldo ${toEs}${fcEs} en la aplicación EcoFlow.` },
    { en: ` Set the reserve to ${toEn}${fcEn} in the EcoFlow app.`, es: ` Ajuste la reserva ${toEs}${fcEs} en la aplicación EcoFlow.` },
  ];
  const candidates: Array<{ en: string; es: string }> = [];
  for (const [i, act] of acts.entries()) {
    if (o.stage === 'onPeak') {
      if (o.unknown) {
        candidates.push({
          en: `Critical. On-peak pricing has started and the ${span} charge still cannot be confirmed stopped.${act.en}`,
          es: `Alarma crítica. Alarma crítica. La tarifa punta ya comenzó y todavía no se puede confirmar que la carga ${spanEs} se detuvo.${act.es}`,
        });
      } else {
        // The consequence is said in full, then (compact) as a clause.
        candidates.push(i === 0
          ? {
            en: `Critical. On-peak pricing has started and the backup reserve still reads ${o.targetPct} percent instead of ${toEn} after the ${span} charge. `
              + `The house is buying grid power at the peak rate to hold it.${act.en}`,
            es: `Alarma crítica. Alarma crítica. La tarifa punta ya comenzó y la reserva de respaldo sigue en el ${o.targetPct} por ciento ${insteadEs} después de la carga ${spanEs}. `
              + `La casa está comprando energía de la red a la tarifa punta para mantenerla.${act.es}`,
          }
          : {
            en: `Critical. On-peak pricing has started and the reserve still reads ${o.targetPct} percent instead of ${toEn} after the ${span} charge, `
              + `so the house buys at the peak rate.${act.en}`,
            es: `Alarma crítica. Alarma crítica. La tarifa punta ya comenzó y la reserva sigue en el ${o.targetPct} por ciento ${insteadEs} tras la carga ${spanEs}; `
              + `la casa compra a tarifa punta.${act.es}`,
          });
      }
      continue;
    }
    const peakEn = peak != null ? `, and on-peak pricing starts at ${peak}` : '';
    const peakEs = peak != null ? `, y la tarifa punta comienza a ${o.onPeakStartMs != null ? esHourArticle(o.onPeakStartMs) : 'las'} ${peak}` : '';
    candidates.push(o.unknown
      ? {
        en: `Critical. The ${span} charge could not be confirmed stopped: the panel is not reporting its reserve${peakEn}.${act.en}`,
        es: `Alarma crítica. Alarma crítica. No se pudo confirmar que la carga ${spanEs} se detuvo: el panel no informa su reserva${peakEs}.${act.es}`,
      }
      : {
        en: `Critical. The ${span} charge did not stop: the backup reserve still reads ${o.targetPct} percent instead of ${toEn}${peakEn}.${act.en}`,
        es: `Alarma crítica. Alarma crítica. La carga ${spanEs} no se detuvo: la reserva de respaldo sigue en el ${o.targetPct} por ciento ${insteadEs}${peakEs}.${act.es}`,
      });
  }
  // The last shape, within the bound by construction: what to do, and why, in the fewest words.
  candidates.push({
    en: `Critical. The ${span} charge's restore is not confirmed.${acts[1].en}`,
    es: `Alarma crítica. Alarma crítica. No se confirma el fin de la carga ${spanEs}.${acts[1].es}`,
  });
  return candidates.find((t) => t.en.length + t.es.length <= MAX_SPOKEN_ADVISORY_CHARS) ?? candidates[candidates.length - 1];
}

/** The critical push beside the mid-day spoken page. PURE. */
export function buildMiddayRevertDeadline(o: MiddayRevertDeadlineText): NotifyMessage {
  const label = `${phxParts(o.windowStartMs).weekdayShort} ${spanText(o.windowStartMs, o.windowEndMs)}`;
  const to = o.restorePct != null ? `${o.restorePct}%` : 'its usual level';
  const peak = o.onPeakStartMs == null ? ''
    : o.stage === 'onPeak' ? ` On-peak pricing started at ${phxClock(o.onPeakStartMs)}.` : ` On-peak pricing starts at ${phxClock(o.onPeakStartMs)}.`;
  const state = o.unknown
    ? `could not be confirmed: the Smart Home Panel 2 is not reporting its reserve, so the charge's ${o.targetPct}% may still stand.`
    : `has not taken effect: the Smart Home Panel 2 still reads ${o.targetPct}%.`;
  return {
    severity: 'critical',
    dedupId: 'night_charge_revert_deadline',
    title: o.unknown ? `Charge (${label}): reserve restore not confirmed` : `Charge (${label}): reserve still raised`,
    body: `The restore of the backup reserve to ${to} after the ${label} charge ${state}${peak} `
      + 'While the reserve stays raised the panel holds it as its floor and buys grid power to refill to it. '
      + `Set the backup reserve to ${to}${o.forceChargeOffOpen ? ' and switch Charge Now off' : ''} in the EcoFlow app. ${revertRetryText(o.retrying)}`,
  };
}
