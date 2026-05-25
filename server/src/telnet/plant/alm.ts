/**
 * ALM screen — alarm console.
 *
 * Sorted newest first. Each alarm shows its timestamp, severity tag,
 * category, identifier, and message. Scrollable with ↑/↓.
 */

import { c, padEnd, truncate, BOX } from '../ansi.js';
import { divider } from './scada.js';
import type { PlantData, PlantView } from './types.js';

export function renderAlm(view: PlantView, data: PlantData): string[] {
  const W = view.width;
  const out: string[] = [];

  // Alerts in the snapshot don't carry their own timestamp — they're
  // computed fresh each refresh cycle. We use snapshot.generatedAt as the
  // "this alarm was present at this moment" stamp.
  const stamp = data.snap.generatedAt ?? Date.now();
  const alerts = (data.snap.alerts ?? []).slice();
  const crit = alerts.filter((a) => a.severity === 'critical').length;
  const warn = alerts.filter((a) => a.severity === 'warning').length;
  const info = alerts.filter((a) => a.severity === 'info').length;

  out.push(divider(`ALARM LIST — ${alerts.length} active`, W));
  out.push(padEnd(
    '  ' + c.redB(`CRIT ${crit}`) + c.grey('  ·  ') + c.yellowB(`WARN ${warn}`) +
    c.grey('  ·  ') + c.cyan(`INFO ${info}`) + c.grey('  ·  ') +
    c.grey('↑/↓ to scroll, ENTER to ack (not yet wired)'),
    W,
  ));
  out.push('');

  if (alerts.length === 0) {
    out.push(c.greenB('  ● NORMAL — no active alarms'));
    return out;
  }

  // Column layout:
  //   TS         SEV    CATEGORY     ID                       MESSAGE
  //   14:32:17   CRIT   THERMAL      pack-hot-Y711...         Pack 3 over 122°F
  const headers = ['TIMESTAMP', 'SEV', 'CATEGORY', 'IDENTIFIER', 'MESSAGE'];
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
    const sevCol = a.severity === 'critical' ? c.redB :
                   a.severity === 'warning' ? c.yellowB : c.cyan;
    const sevTag = a.severity === 'critical' ? 'CRIT' : a.severity === 'warning' ? 'WARN' : 'INFO';
    // Compose the message line: title + optional detail.
    const msg = a.detail ? `${a.title} — ${a.detail}` : a.title;
    out.push('  ' + [
      padEnd(c.grey(tstr), 19),
      padEnd(sevCol(sevTag), 6),
      padEnd(c.white((a.category ?? '—').toUpperCase()), 12),
      padEnd(c.white(truncate(a.id ?? '—', 22)), 22),
      c.whiteB(truncate(msg ?? '', Math.max(20, W - 64))),
    ].join(' '));
  }

  if (alerts.length > visible.length) {
    out.push('');
    out.push(padEnd(c.grey(`  … ${alerts.length - start - visible.length} more below (↓ to scroll)`), W));
  }

  return out;
}
