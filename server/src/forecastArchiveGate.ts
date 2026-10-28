/**
 * forecastArchiveGate.ts — whether a forecast's next-24h PV may enter the day-ahead archive.
 *
 * v1.191.4 — the 45-minute GHI tick archived `forecastPvWhNext24` whatever its basis, so while
 * every home Core was dark it wrote 0 Wh for days that had sun. The archive accumulates as the
 * band calibrator's future out-of-sample record of what was forecast (nothing reads it yet), and a
 * 0 there would be scored as a forecast that missed by the whole day's yield.
 *
 * The forecast already says when its alarm-facing PV is short: the restored (display) sum re-adds
 * each connected Core that is not projected, and with every Core projected the two sums are equal
 * by contract (v0.78.0; v1.177.0 gave both the same bias correction and ceiling). So a row is
 * archived only when they agree, the PV forecast is available and no Core's first reading is
 * pending. A skipped tick leaves an hour without a row: no data, where a short figure would be a
 * wrong one.
 */
export interface ArchivableForecast {
  forecastPvWhNext24: number;
  forecastPvWhNext24Display: number;
  pvForecastUnavailable?: boolean;
  homeBasisPending?: boolean;
}

export function forecastArchivable(fc: ArchivableForecast | null | undefined): fc is ArchivableForecast {
  return fc != null
    && Number.isFinite(fc.forecastPvWhNext24)
    && fc.forecastPvWhNext24 === fc.forecastPvWhNext24Display
    && fc.pvForecastUnavailable !== true
    && fc.homeBasisPending !== true;
}
