/**
 * v1.183.0 — small card wording rules. Pure (run by server/test/auditLastThree.test.ts).
 */

export type Tone = 'bad' | 'warn' | 'ok' | 'muted';

/**
 * The Forecast card's Outlook. With no projection at all (minProjectedSoc null — no SoC basis,
 * cold history) it fell through to a green "Comfortable": the most reassuring word, shown exactly
 * when nothing had been projected. No projection now reads "—" in a neutral tone.
 */
export function outlookOf(minProjectedSoc: number | null, reserveSoc: number): { label: string; tone: Tone } {
  if (minProjectedSoc == null) return { label: '—', tone: 'muted' };
  if (minProjectedSoc < reserveSoc) return { label: 'Tight', tone: 'bad' };
  if (minProjectedSoc < reserveSoc + 15) return { label: 'Watch', tone: 'warn' };
  return { label: 'Comfortable', tone: 'ok' };
}

/**
 * The DPU card's countdown. The vendor's remainTime is time-to-FULL while charging and
 * time-to-EMPTY while discharging; the card labelled both "remain", so a charge countdown read as
 * a runtime. batAmp (project.ts) is positive while charging, negative while discharging.
 */
export function remainSuffix(batAmp: number | null | undefined): string {
  if (batAmp == null || !Number.isFinite(batAmp)) return 'remaining';
  if (batAmp > 0.5) return 'to full';
  if (batAmp < -0.5) return 'to empty';
  return 'remaining';
}

/** The same rule for a pack readout labelled on its own (Thermal page): "To full" while its input
 *  exceeds its output, "To empty" while its output does, else "Remaining". */
export function packCountdownLabel(inputWatts: number | null | undefined, outputWatts: number | null | undefined): string {
  const net = (inputWatts ?? 0) - (outputWatts ?? 0);
  if (inputWatts == null && outputWatts == null) return 'Remaining';
  return net > 5 ? 'To full' : net < -5 ? 'To empty' : 'Remaining';
}

/**
 * The Strategy tab's note for a circuit the SHP2 lists with `loadIsEnable: false`. That flag is
 * from the panel's LoadStrategyCfg — whether the circuit takes part in its load-priority strategy —
 * not the relay: the tab struck such a circuit through as "turned off in the SHP2" while it was
 * drawing power. Null when the circuit is in the strategy.
 */
export function strategyExclusion(loadIsEnable: boolean | null | undefined, watts: number | null | undefined): { badge: string; note: string } | null {
  if (loadIsEnable !== false) return null;
  const drawing = watts != null && watts > 1;
  return {
    badge: 'not in strategy',
    note: drawing
      ? `not in the SHP2's load strategy — still powered, drawing ${Math.round(watts!)} W`
      : "not in the SHP2's load strategy",
  };
}
