/**
 * v1.190.2 — what the Today figures say about where they came from.
 *
 * While a home Core is dark (no reading of its own) the server's energy bridge meters it at its
 * Smart Home Panel 2 source slot, and `/api/summary/today` counts the energy the bridge booked for
 * it — the figures Home Assistant's Energy counters add — in place of its absent samples
 * (`fleet.bridged`: server/src/aggregator.ts BridgedTotals). A figure with a panel-metered part says
 * so: "via panel". Solar booked on the bridge's inferred basis is a lower bound (net slot output plus
 * the stored-energy rise, short of the Cores' own draw) and says that too. At night the bridge books
 * no solar (the sun is down: physics, not a reading), so a night-only bridged span leaves the Solar
 * figure unmarked. Pure, so the server suite runs it (server/test/todayBridge.test.ts).
 */

/** The bridge's share of the day, as the server sends it (aggregator.ts BridgedTotals). */
export interface TodayBridged {
  pvWh: number;
  acOutWh: number;
  acInWh: number;
  chargeWh: number;
  dischargeWh: number;
  pvInferredWh: number;
  windows: { night: number; measured: number; inferred: number; unbridgeable: number };
  cores: string[];
}

export interface TodayNotes {
  /** Solar produced: null, 'via panel', 'via panel · lower bound' or 'via panel · partly a lower bound'. */
  solar: string | null;
  /** AC output and Batteries (net): null or 'via panel'. */
  acOut: string | null;
  battery: string | null;
}

export function todayNotes(b: TodayBridged | undefined | null): TodayNotes {
  if (!b) return { solar: null, acOut: null, battery: null };
  const w = b.windows;
  const booked = w.night + w.measured + w.inferred > 0;
  const daylight = w.measured + w.inferred > 0;
  let solar: string | null = null;
  if (daylight) {
    if (b.pvInferredWh > 0 && w.measured === 0) solar = 'via panel · lower bound';
    else if (b.pvInferredWh > 0) solar = 'via panel · partly a lower bound';
    else solar = 'via panel';
  }
  return { solar, acOut: booked ? 'via panel' : null, battery: booked ? 'via panel' : null };
}

/** The Batteries (net) sub-label: the direction, and the panel note when there is one. */
export function batterySub(netWh: number, note: string | null): string {
  const dir = netWh > 0 ? 'discharged' : 'charged';
  return note ? `${dir} · ${note}` : dir;
}
