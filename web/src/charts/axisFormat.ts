/**
 * v1.183.0 — chart axis ticks. Pure (run by server/test/auditLastThree.test.ts).
 *
 * The Forecast chart's watt axis printed `${(v / 1000).toFixed(0)}k`: no unit, and neighbouring
 * ticks rounded to the same label (1500 and 2000 both "2k"), so the axis read uneven. The trend
 * charts printed the unit on every tick (" W") inside a fixed 48 px axis, and "10000 W" wrapped
 * the unit onto a stray second line. Ticks are now compact numbers and the unit is the axis label.
 */

/** At most `d` decimals, trailing zeros dropped: 1.50 → "1.5", 2.00 → "2". */
export function trimDecimals(v: number, d = 1): string {
  return String(Number(v.toFixed(d)));
}

/** 950 → "950", 1500 → "1.5k", 12345 → "12.3k", -2000 → "-2k". */
export function compactTick(v: number): string {
  return Math.abs(v) >= 1000 ? `${trimDecimals(v / 1000)}k` : trimDecimals(v);
}

/** A watt value shown on a kW axis: 1500 → "1.5", 2000 → "2", 250 → "0.3". */
export function kwTick(watts: number): string {
  return trimDecimals(watts / 1000);
}
