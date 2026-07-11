/**
 * ALM screen — alarm console.
 *
 * Sorted newest first. Each alarm shows its timestamp, ISA priority tag,
 * category, identifier, and message. Scrollable with ↑/↓.
 */

import { c, padEnd } from '../ansi.js';
import { divider } from './scada.js';
import type { PlantData, PlantView } from './types.js';
// v0.11.0 — derive the 4-tier ISA-18.2 / IEC 62682 alarm priority for display.
import { priorityOf, priorityMeta, type AlarmPriority } from '../../alertPriority.js';

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

export function renderAlm(view: PlantView, data: PlantData): string[] {
  const W = view.width;
  const out: string[] = [];

  // Alerts in the snapshot don't carry their own timestamp — they're
  // computed fresh each refresh cycle. We use snapshot.generatedAt as the
  // "this alarm was present at this moment" stamp.
  const stamp = data.snap.generatedAt ?? Date.now();
  const alerts = (data.snap.alerts ?? []).slice();
  // v0.11.0 — tally by the 4-tier ISA priority instead of raw severity.
  const pc: Record<AlarmPriority, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const a of alerts) pc[priorityOf(a)]++;

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
  const tsDate = new Date(stamp);
  const p2 = (n: number) => String(n).padStart(2, '0');
  const tstr = `${tsDate.getFullYear()}-${p2(tsDate.getMonth() + 1)}-${p2(tsDate.getDate())} ${p2(tsDate.getHours())}:${p2(tsDate.getMinutes())}:${p2(tsDate.getSeconds())}`;

  // v1.4.3 (audit rank 26) — WRAP the message instead of hard-truncating it. The MESSAGE
  // column starts at fixed offset 65 (2 indent + 19 TS + 1 + 6 PRIO + 1 + 12 CAT + 1 + 22 ID
  // + 1), and the alarm detail (e.g. "Backup pool 17% is close to the 10% reserve floor — grid
  // is backstopping…") routinely runs past it. The old `truncate(msg, W-64)` silently clipped
  // the operative half of the alarm — "grid is bac…" — with no cue. Wrap onto continuation
  // lines aligned under MESSAGE so the full text is always readable.
  const MSG_COL = 65;
  const msgWidth = Math.max(8, W - MSG_COL);          // fills exactly to W, never overflows
  const contIndent = ' '.repeat(MSG_COL);
  // v1.4.3 (audit rank 10/41) — budget rows against the ACTUAL body height (plant/index.ts
  // clips to H-2, and this screen's own header is 4 lines), not a fixed 30-row slice, so the
  // "N more below" hint is honest at any terminal height.
  const rowBudget = Math.max(4, view.height - 8);

  let usedRows = 0;
  let shown = 0;
  for (let i = start; i < alerts.length; i++) {
    const a = alerts[i];
    const prio = priorityOf(a);
    const prioTag = priorityMeta(prio).tag;
    const msg = a.detail ? `${a.title} — ${a.detail}` : a.title;
    const wrapped = wrapPlain(msg ?? '', msgWidth);
    // Don't start an alarm whose wrapped block can't finish inside the budget (but always
    // render at least the first alarm so a very tall message on a short screen still shows).
    if (shown > 0 && usedRows + wrapped.length > rowBudget) break;
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
