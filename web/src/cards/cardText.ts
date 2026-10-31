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

/** A Delta Pro Ultra carries one to five battery packs (hardware maximum). */
export const DPU_MAX_PACKS = 5;

/**
 * v1.187.18 — the DPU card's pack tiles: one per pack NUMBER the Core reports, or null when the
 * count is unknown. The card drew `p?.packs.length ?? 5` tiles: a Core with no direct projection
 * (after a restart while it is cloud-offline, and briefly at every boot) showed "5 battery packs"
 * and five placeholders whatever it holds — Core 4 has run on four since 2026-09-20. The count is
 * the larger of the packs present and the Core's own valid pack count (bpNum, 1–5), and tiles are
 * keyed by number, so a pack the projection is missing keeps its own position as a placeholder.
 * Null (no projection, or no packs and no valid count) renders one line instead of tiles.
 */
export function dpuPackSlots(
  p: { packCount: number | null; packs: ReadonlyArray<{ num: number }> } | null | undefined,
): number[] | null {
  if (!p) return null;
  const nums = new Set<number>();
  const bp = p.packCount;
  if (bp != null && Number.isInteger(bp) && bp >= 1 && bp <= DPU_MAX_PACKS) {
    for (let n = 1; n <= bp; n++) nums.add(n);
  }
  for (const pk of p.packs) if (Number.isInteger(pk.num) && pk.num >= 1) nums.add(pk.num);
  return nums.size > 0 ? [...nums].sort((a, b) => a - b) : null;
}

/** v1.195.0 — the fields of a forecast hour forecastView reads (web/src/types.ts ForecastHour). */
export interface ForecastHourLike {
  ts: number;
  forecastPvW: number;
  projectedSocPct: number | null;
}
/** v1.195.0 — one hour of the restored basis (DayForecast.hoursDisplay): its solar, its projected SoC
 *  and the restored model's own flag for the hour (the "model" / "typical" source badge). */
export interface ForecastHourDisplayLike extends ForecastHourLike {
  modelled?: boolean;
}
/** v1.195.0 — the fields of GET /api/forecast forecastView reads. The display fields are optional:
 *  an older server sends none of them, and the view is then the alarm basis, as before. */
export interface ForecastViewInput<H extends ForecastHourLike> {
  hours: ReadonlyArray<H>;
  forecastPvWhNext24: number;
  typicalPvWhPerDay: number;
  minProjectedSoc: number | null;
  minProjectedSocTs: number | null;
  forecastPvWhNext24Display?: number;
  typicalPvWhPerDayDisplay?: number;
  hoursDisplay?: ReadonlyArray<ForecastHourDisplayLike>;
  minProjectedSocDisplay?: number | null;
  minProjectedSocTsDisplay?: number | null;
  restoredCoreCount?: number;
  pvForecastUnavailable?: boolean;
  /** v1.195.0 — built while a home Core listed ONLINE had sent no first reading yet (the boot race;
   *  DayForecast.homeBasisPending). Such a Core is restored from its records but is not offline. */
  homeBasisPending?: boolean;
}
/** v1.195.0 — what the forecast cards show (forecastView). */
export interface ForecastView<H extends ForecastHourLike> {
  /** The solar and SoC figures are the RESTORED display basis: home Cores are offline in the cloud
   *  and their own recorded production stands in for them. */
  restored: boolean;
  /** How many offline Cores were restored (0 unless `restored`). */
  restoredCores: number;
  /** v1.195.0 (review) — `restored`, on a forecast built while a home Core listed online had not sent
   *  its first reading (homeBasisPending, at most HOME_BASIS_PENDING_MAX_MS after a restart). Some of
   *  the restored Cores are then not offline, and the badge does not call them so. */
  pending: boolean;
  /** Solar over the next 24 h (Wh); null when there is no PV history to project from. */
  pvWh: number | null;
  typicalWh: number | null;
  minSoc: number | null;
  minSocTs: number | null;
  /** The hours to draw: load from the forecast; solar, projected SoC and the model flag from the
   *  restored basis when `restored`. `alarmSocPct` is the runway alarm's own SoC path, set only when
   *  `restored` (the chart's dashed line); `alarmPvW` the alarm's solar. */
  hours: Array<H & { alarmSocPct: number | null; alarmPvW: number }>;
  /** The runway alarm's basis (the reporting Cores only), for the line beside the tiles. */
  alarm: { pvWh: number; minSoc: number | null; minSocTs: number | null };
}

/**
 * v1.195.0 — the forecast cards' figures. While every home Core was offline in the EcoFlow cloud the
 * cards showed the RUNWAY ALARM's basis — the Cores reporting live, here none — so they read 0 kWh of
 * solar, a projected low of 0% and a "Tight" outlook, while Home Assistant's forecast solar sensor
 * showed the restored ~50 kWh. With any Core restored (restoredCoreCount > 0: an offline Core with a
 * recorded PV history, and the per-hour restored series present) the cards now show the restored
 * basis: the solar and the projected SoC rebuilt from each offline Core's own recorded production,
 * labelled as restored, with the alarm basis beside it (`alarm`). While a home Core listed online has
 * not sent its first reading (homeBasisPending) the label says so instead of calling it offline
 * (`pending`). With none restored the view is the alarm basis (with every Core reporting the two are
 * equal), as is a payload from an older server. No PV history at all (pvForecastUnavailable) shows no
 * solar figure: the server's 0 there is not a forecast. PURE (run by
 * server/test/forecastDisplayBasis.test.ts).
 */
export function forecastView<H extends ForecastHourLike>(fc: ForecastViewInput<H>): ForecastView<H> {
  const restored = (fc.restoredCoreCount ?? 0) > 0 && fc.hoursDisplay != null;
  const byTs = new Map((restored ? fc.hoursDisplay! : []).map((d) => [d.ts, d] as const));
  const noPv = fc.pvForecastUnavailable === true;
  return {
    restored,
    restoredCores: restored ? fc.restoredCoreCount! : 0,
    pending: restored && fc.homeBasisPending === true,
    pvWh: noPv ? null : restored ? (fc.forecastPvWhNext24Display ?? fc.forecastPvWhNext24) : fc.forecastPvWhNext24,
    typicalWh: noPv ? null : restored ? (fc.typicalPvWhPerDayDisplay ?? fc.typicalPvWhPerDay) : fc.typicalPvWhPerDay,
    minSoc: restored ? (fc.minProjectedSocDisplay ?? null) : fc.minProjectedSoc,
    minSocTs: restored ? (fc.minProjectedSocTsDisplay ?? null) : fc.minProjectedSocTs,
    hours: fc.hours.map((h) => {
      const d = byTs.get(h.ts);
      return d
        ? {
          ...h, forecastPvW: d.forecastPvW, projectedSocPct: d.projectedSocPct,
          // The source badge names the model that made the figure shown, the restored one.
          ...(d.modelled != null ? { modelled: d.modelled } : {}),
          alarmSocPct: h.projectedSocPct, alarmPvW: h.forecastPvW,
        }
        : { ...h, alarmSocPct: null, alarmPvW: h.forecastPvW };
    }),
    alarm: { pvWh: fc.forecastPvWhNext24, minSoc: fc.minProjectedSoc, minSocTs: fc.minProjectedSocTs },
  };
}

/** v1.195.0 — the badge beside the coverage badge while the forecast is on the restored basis.
 *  v1.195.0 (review) — `pending` (ForecastView.pending): at a restart a Core listed online whose first
 *  reading has not landed is restored from its records too, for up to HOME_BASIS_PENDING_MAX_MS. It is
 *  not offline, and the badge read "Solar restored from 3 offline Cores' records" at every restart. */
export function restoredSolarBadge(n: number, pending: boolean): string {
  const cores = n === 1 ? "1 Core's" : `${n} Cores'`;
  return pending ? `Solar from ${cores} records (first reading pending)`
    : n === 1 ? "Solar restored from 1 offline Core's records" : `Solar restored from ${n} offline Cores' records`;
}

/** v1.195.0 — the line under the tiles while the forecast is on the restored basis: the figures the
 *  runway alarm (and the projected-dip alert, the calendar's dip event and Home Assistant's
 *  projected-low sensors) uses. */
export function alarmBasisLine(alarm: ForecastView<ForecastHourLike>['alarm']): string {
  const low = alarm.minSoc == null ? '—' : `${alarm.minSoc.toFixed(0)}%`;
  return `Runway alarm basis (reporting Cores only): ${(alarm.pvWh / 1000).toFixed(1)} kWh solar, low ${low}`;
}
