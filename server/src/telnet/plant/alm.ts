/**
 * ALM screen — alarm console.
 *
 * An ISA-18.1-style annunciator header (one legend tile per alarm category,
 * lit when that group has an active alert) sits above the alarm list.
 * The list is sorted newest first; each alarm shows its timestamp, ISA
 * priority tag, category, identifier, and message. Scrollable with ↑/↓.
 */

import { c, padEnd } from '../ansi.js';
import { divider } from './scada.js';
// v1.38.0 — annunciator legend tiles (3-row lamp boxes; plain strings,
// colorized whole per tile).
import { tile } from '../gauges.js';
import type { PlantData, PlantView } from './types.js';
// v0.11.0 — derive the 4-tier ISA-18.2 / IEC 62682 alarm priority for display.
import { priorityOf, priorityMeta, type AlarmPriority } from '../../alertPriority.js';
import { getAlertOnset } from '../../alertOnset.js';

/** ANSI colourizer for an ISA priority. No orange in the 16-colour palette, so
 *  High shares Critical's bright-red; Medium = bright-yellow; Low = cyan. */
function prioColor(p: AlarmPriority): (s: string) => string {
  return p === 'critical' ? c.redB : p === 'high' ? c.redB : p === 'medium' ? c.yellowB : c.cyan;
}

/** Word-wrap a PLAIN (un-coloured) string to lines no wider than `width`; a single
 *  token longer than the column is hard-broken. Returns at least one (possibly empty)
 *  line so the caller always has a row to colourise. */
function wrapPlain(s: string, width: number): string[] {
  const w = Math.max(8, width);
  const lines: string[] = [];
  let cur = '';
  for (let word of s.split(/\s+/).filter(Boolean)) {
    while (word.length > w) {
      if (cur) { lines.push(cur); cur = ''; }
      lines.push(word.slice(0, w));
      word = word.slice(w);
    }
    if (!cur) cur = word;
    else if (cur.length + 1 + word.length <= w) cur += ' ' + word;
    else { lines.push(cur); cur = word; }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

/**
 * Fixed annunciator panel roster: one legend window per alert category
 * (the alerts.ts category union), plus a SYSTEM catch-all so an alarm with an
 * unrecognized category can never bypass the panel unlit. Keys are matched
 * case-insensitively; labels are sized to fit an 80-col 7-tile panel.
 */
const ANNUN_TILES: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'battery', label: 'BATTERY' },
  { key: 'solar', label: 'SOLAR' },
  { key: 'thermal', label: 'THERMAL' },
  { key: 'shp2', label: 'SHP2' },
  { key: 'grid', label: 'GRID' },
  { key: 'connectivity', label: 'COMMS' },
  { key: 'system', label: 'SYSTEM' },
];

/** Rows the annunciator header occupies (tile() is always 3 rows). */
const ANNUN_ROWS = 3;

/**
 * Render the annunciator header: equal-width tiles, as many as fit at ≥ 8
 * cols each (all seven fit from 80 cols up), 1-col gaps. A lit tile is red
 * when the group holds a Critical/High alarm, yellow when only Medium/Low;
 * dark tiles are grey. Tiles are plain strings colorized whole — visible
 * width is 2 + shown×tileW + (shown−1), always ≤ `width`.
 */
function renderAnnunciator(alerts: PlantData['snap']['alerts'], width: number): string[] {
  const byCat = new Map<string, { crit: boolean }>();
  for (const a of alerts ?? []) {
    const raw = (a.category ?? '').toLowerCase();
    const key = ANNUN_TILES.some((t) => t.key === raw) ? raw : 'system';
    const cur = byCat.get(key) ?? { crit: false };
    const p = priorityOf(a);
    if (p === 'critical' || p === 'high') cur.crit = true;
    byCat.set(key, cur);
  }
  const minTileW = 8;
  const shown = Math.min(ANNUN_TILES.length, Math.max(1, Math.floor((width - 2 + 1) / (minTileW + 1))));
  const tileW = Math.min(18, Math.floor((width - 2 - (shown - 1)) / shown));
  if (tileW < 3) return [];
  // v1.47.1 (full-pass) — when the width can't fit the whole roster, the
  // trailing tiles fold into the LAST visible window instead of vanishing:
  // the final tile becomes the catch-all, lit (at the highest folded
  // severity) if ANY hidden group is lit. The invariant this preserves is the
  // panel's reason to exist — no active alarm group can ever be unlit merely
  // because the terminal is narrow.
  const visible = ANNUN_TILES.slice(0, shown);
  const folded = ANNUN_TILES.slice(shown);
  const rows = ['', '', ''];
  for (let i = 0; i < shown; i++) {
    const t = visible[i];
    let group = byCat.get(t.key);
    if (i === shown - 1) {
      for (const f of folded) {
        const fg = byCat.get(f.key);
        if (fg) group = { crit: (group?.crit ?? false) || fg.crit };
      }
    }
    const lit = group != null;
    const paint = group == null ? c.grey : group.crit ? c.redB : c.yellowB;
    const box = tile(t.label, lit, tileW);
    const sep = i > 0 ? ' ' : '';
    for (let r = 0; r < ANNUN_ROWS; r++) rows[r] += sep + paint(box[r]);
  }
  return rows.map((r) => '  ' + r);
}

export function renderAlm(view: PlantView, data: PlantData): string[] {
  const W = view.width;
  const out: string[] = [];

  // v1.x — each alarm now stamps its own ONSET from the restart-persistent
  // alertOnset sidecar (see getAlertOnset() in the render loop below).
  // `stamp` is kept only as the FALLBACK for an id the sidecar hasn't
  // recorded yet (e.g. it fired between the last alertMonitor sync tick and
  // this render) — previously this was blindly used as EVERY alarm's
  // timestamp, so a long-standing alarm displayed the current refresh time,
  // not when it actually started.
  const stamp = data.snap.generatedAt ?? Date.now();
  const alerts = (data.snap.alerts ?? []).slice();
  // v0.11.0 — tally by the 4-tier ISA priority instead of raw severity.
  const pc: Record<AlarmPriority, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const a of alerts) pc[priorityOf(a)]++;

  // v1.38.0 — annunciator header above the list. A real ISA panel keeps all
  // its windows visible at all times (a dark tile IS information), so this
  // renders on an empty alarm list too.
  const annun = renderAnnunciator(alerts, W);
  out.push(...annun);

  out.push(divider(`ALARM LIST — ${alerts.length} active`, W));
  out.push(padEnd(
    '  ' + prioColor('critical')(`CRIT ${pc.critical}`) + c.grey('  ·  ') +
    prioColor('high')(`HIGH ${pc.high}`) + c.grey('  ·  ') +
    prioColor('medium')(`MED ${pc.medium}`) + c.grey('  ·  ') +
    prioColor('low')(`LOW ${pc.low}`) + c.grey('  ·  ') +
    c.grey('↑/↓ to scroll, ENTER to ack (not yet wired)'),
    W,
  ));
  out.push('');

  if (alerts.length === 0) {
    out.push(c.greenB('  ● NORMAL — no active alarms'));
    return out;
  }

  // Column layout:
  //   TS         PRIO   CATEGORY     ID                       MESSAGE
  //   14:32:17   CRIT   THERMAL      pack-hot-Y711...         Pack 3 over 122°F
  const headers = ['TIMESTAMP', 'PRIO', 'CATEGORY', 'IDENTIFIER', 'MESSAGE'];
  out.push('  ' + c.grey([
    padEnd(headers[0], 19),
    padEnd(headers[1], 6),
    padEnd(headers[2], 12),
    padEnd(headers[3], 22),
    headers[4],
  ].join(' ')));

  const start = Math.max(0, Math.min(alerts.length - 1, view.almScroll));
  const p2 = (n: number) => String(n).padStart(2, '0');
  // v1.x — per-alarm TIMESTAMP formatter; each row stamps its own ONSET (see
  // the getAlertOnset() call inside the render loop below), not one shared
  // refresh-time string.
  const fmtTs = (ms: number) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
  };

  // v1.4.3 (audit rank 26) — WRAP the message instead of hard-truncating it. The MESSAGE
  // column starts at fixed offset 65 (2 indent + 19 TS + 1 + 6 PRIO + 1 + 12 CAT + 1 + 22 ID
  // + 1), and the alarm detail (e.g. "Backup pool 17% is close to the 10% reserve floor — grid
  // is backstopping…") routinely runs past it. The old `truncate(msg, W-64)` silently clipped
  // the operative half of the alarm — "grid is bac…" — with no cue. Wrap onto continuation
  // lines aligned under MESSAGE so the full text is always readable.
  // v1.47.1 (full-pass) — the fixed 65-col offset left ZERO visible message on
  // 60-64-col terminals (the session's minimum is 60): the row rendered only
  // TS/PRIO/CAT/ID and the wrapped continuation lines were entirely blank. The
  // column adapts so at least ~24 message columns always survive; the fixed
  // prefix columns are truncated by the same padEnd that always governed them.
  const MSG_COL = Math.min(65, Math.max(24, W - 24));
  const msgWidth = Math.max(8, W - MSG_COL);          // fills exactly to W, never overflows
  const contIndent = ' '.repeat(MSG_COL);
  // v1.4.3 (audit rank 10/41) — budget rows against the ACTUAL body height (plant/index.ts
  // clips to H-2, and this screen's own header is 4 lines), not a fixed 30-row slice, so the
  // "N more below" hint is honest at any terminal height.
  // v1.38.0 — the annunciator header above the divider consumes its rows from
  // the same budget.
  const rowBudget = Math.max(4, view.height - 8 - annun.length);

  // v1.x — reserve two rows (blank + "… N more below") so the scroll cue can
  // never be pushed off the bottom by the alarm rows above it.
  const moreBelow = alerts.length - start > 1;
  const bodyBudget = moreBelow ? Math.max(2, rowBudget - 2) : rowBudget;
  let usedRows = 0;
  let shown = 0;
  for (let i = start; i < alerts.length; i++) {
    const a = alerts[i];
    const prio = priorityOf(a);
    const prioTag = priorityMeta(prio).tag;
    // v1.x — true onset (restart-persistent sidecar), falling back to the
    // per-refresh `stamp` only when this id has no recorded onset yet.
    const tstr = fmtTs(getAlertOnset(a.id) ?? stamp);
    const msg = a.detail ? `${a.title} — ${a.detail}` : a.title;
    const wrapped = wrapPlain(msg ?? '', msgWidth);
    // v1.x — a single pathologically-long alarm used to consume the whole screen
    // at 80×24, pushing the "… N more below" cue (and every other active alarm)
    // off the bottom with no indication more existed. When it's the FIRST row and
    // its own wrapped block overruns the body budget while other alarms wait
    // below, cap it and mark the truncation with " …" so the operator sees both
    // the alarm's start AND that there's more to scroll to. (A lone long alarm
    // with nothing below still renders in full — the v1.4.3 wrap is unchanged.)
    if (shown === 0 && moreBelow && wrapped.length > bodyBudget) {
      const cap = Math.max(1, bodyBudget - 1);
      wrapped.length = cap;
      wrapped[cap - 1] = `${wrapped[cap - 1] ?? ''} …`;
    }
    // Don't start an alarm whose wrapped block can't finish inside the budget (but always
    // render at least the first alarm so a very tall message on a short screen still shows).
    if (shown > 0 && usedRows + wrapped.length > bodyBudget) break;
    out.push('  ' + [
      padEnd(c.grey(tstr), 19),
      padEnd(prioColor(prio)(prioTag), 6),
      padEnd(c.white((a.category ?? '—').toUpperCase()), 12),
      // v0.95.0 (re-audit #8) — MIDDLE-truncate the id so the trailing pack/slot
      // discriminator survives (end-truncation collapsed distinct per-pack alarms into one row).
      padEnd(c.white((() => { const s = a.id ?? '—'; return s.length > 22 ? s.slice(0, 12) + '…' + s.slice(-9) : s; })()), 22),
      c.whiteB(wrapped[0]),
    ].join(' '));
    for (let j = 1; j < wrapped.length; j++) out.push(contIndent + c.whiteB(wrapped[j]));
    usedRows += wrapped.length;
    shown++;
  }

  const remaining = alerts.length - start - shown;
  if (remaining > 0) {
    out.push('');
    out.push(padEnd(c.grey(`  … ${remaining} more below (↓ to scroll)`), W));
  }

  return out;
}
