/**
 * Plant Operator render dispatcher — frames a screen with the standard
 * top status header / alarm banner / body / footer hotkey legend.
 *
 * The Plant interface deliberately uses single-line borders (vs. the
 * double-line bordered frame the SUMMARY interface uses), to keep the
 * vibe distinct on sight.
 */

import { c, padEnd, BOX } from '../ansi.js';
import { footerLegend, statusHeader } from './scada.js';
import { uptime } from './data.js';
import { renderConsole } from './console.js';
import { renderGen } from './gen.js';
import { renderBus } from './bus.js';
import { renderPv } from './pv.js';
import { renderAlm } from './alm.js';
import { renderTrd } from './trd.js';
import type { PlantView, PlantData, PlantScreenId } from './types.js';
import { PLANT_SCREENS, PLANT_SCREEN_LABEL } from './types.js';
import type { Recorder } from '../../recorder.js';

export { PLANT_SCREENS };
export type { PlantScreenId, PlantView, PlantData };

export interface PlantContext {
  recorder: Recorder;
}

/**
 * Render one full Plant frame. Returns the array of lines, NOT including
 * the trailing newline — the caller (telnet server) joins + writes.
 */
export function renderPlant(view: PlantView, data: PlantData, ctx: PlantContext): string[] {
  const W = view.width;
  const H = view.height;
  // Body area: leave 2 lines for footer (rule + legend).
  const footerLines = 2;
  const bodyMaxH = Math.max(8, H - footerLines);

  const lines: string[] = [];
  const body = screenBody(view, data, ctx);
  // Clip body if it overflows; otherwise let it draw as-is.
  const cap = Math.min(body.length, bodyMaxH);
  for (let i = 0; i < cap; i++) lines.push(padEnd(body[i], W));
  // Pad to fill the body region (so the footer always lands at the bottom).
  while (lines.length < bodyMaxH) lines.push(padEnd('', W));

  // Footer rule + hotkey legend.
  lines.push(c.grey('─'.repeat(W)));
  lines.push(renderFooter(view, W));
  return lines;
}

function screenBody(view: PlantView, data: PlantData, ctx: PlantContext): string[] {
  switch (view.screen) {
    case 'console': return renderConsole(view, data);
    case 'gen':     return renderGen(view, data);
    case 'bus':     return renderBus(view, data);
    case 'pv':      return renderPv(view, data);
    case 'alm':     return renderAlm(view, data);
    case 'trd':     return renderTrd(view, data, ctx);
  }
}

function renderFooter(view: PlantView, width: number): string {
  const tabs = PLANT_SCREENS.map((id, i) => ({
    key: String(i + 1),
    short: PLANT_SCREEN_LABEL[id],
    active: id === view.screen,
  }));
  const extra =
    c.cyanB('TAB') + ' ' + c.grey('next') + '   ' +
    c.cyanB('Q') + ' ' + c.grey('quit');
  return footerLegend(tabs, extra, width);
}
