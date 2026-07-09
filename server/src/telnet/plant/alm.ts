/**
 * ALM screen — alarm console.
 *
 * Sorted newest first. Each alarm shows its timestamp, ISA priority tag,
 * category, identifier, and message. Scrollable with ↑/↓.
 */

import { c, padEnd, truncate, BOX } from '../ansi.js';
import { divider } from './scada.js';
import type { PlantData, PlantView } from './types.js';
// v0.11.0 — derive the 4-tier ISA-18.2 / IEC 62682 alarm priority for display.
import { priorityOf, priorityMeta, type AlarmPriority } from '../../alertPriority.js';

/** ANSI colourizer for an ISA priority. No orange in the 16-colour palette, so
 *  High shares Critical's bright-red; Medium = bright-yellow; Low = cyan. */
function prioColor(p: AlarmPriority): (s: string) => string {
  return p === 'critical' ? c.redB : p === 'high' ? c.redB : p === 'medium' ? c.yellowB : c.cyan;
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
  // We render as many rows as we have body height for; the dispatcher will
  // clip to actual height anyway. Use a generous max here.
  const visible = alerts.slice(start, start + 30);
  const tsDate = new Date(stamp);
  const p2 = (n: number) => String(n).padStart(2, '0');
  const tstr = `${tsDate.getFullYear()}-${p2(tsDate.getMonth() + 1)}-${p2(tsDate.getDate())} ${p2(tsDate.getHours())}:${p2(tsDate.getMinutes())}:${p2(tsDate.getSeconds())}`;
  for (const a of visible) {
    const prio = priorityOf(a);
    const prioTag = priorityMeta(prio).tag;
    // Compose the message line: title + optional detail.
    const msg = a.detail ? `${a.title} — ${a.detail}` : a.title;
    out.push('  ' + [
      padEnd(c.grey(tstr), 19),
      padEnd(prioColor(prio)(prioTag), 6),
      padEnd(c.white((a.category ?? '—').toUpperCase()), 12),
      // v0.95.0 (re-audit #8) — MIDDLE-truncate the id so the trailing pack/slot
      // discriminator survives. End-truncation dropped it: 'soc-low-<14-char-SN>-1' and
      // '…-4' both clipped to the same 22-char 'soc-low-<SN>' head, rendering distinct
      // per-pack SoC alarms as byte-identical rows. Keep head + tail with an ellipsis.
      padEnd(c.white((() => { const s = a.id ?? '—'; return s.length > 22 ? s.slice(0, 12) + '…' + s.slice(-9) : s; })()), 22),
      c.whiteB(truncate(msg ?? '', Math.max(20, W - 64))),
    ].join(' '));
  }

  if (alerts.length > visible.length) {
    out.push('');
    out.push(padEnd(c.grey(`  … ${alerts.length - start - visible.length} more below (↓ to scroll)`), W));
  }

  return out;
}
