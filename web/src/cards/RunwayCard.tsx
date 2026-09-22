import { memo } from 'react';
import type { RunwayProjection } from '../types';
import { usePolled, useNow } from '../usePolled';
import { pollStale } from '../freshness';
import { StaleNote } from '../components/StaleNote';
import { holdsLabel, troughTight, recentLoadCaption } from './runwayText';

const RUNWAY_POLL_MS = 60_000;

/**
 * Live off-grid runway — single most actionable number during a storm.
 * Projects the islanded backup pool hour-by-hour from the day-of-week load curve (predicted
 * EV charging excluded, the last hour's load blended into the first 4 hours) and the
 * next-24-hour forecast PV, surfacing hours-to-reserve, hours-to-empty and the lowest point.
 */
// v0.22.0 — zero-prop card: memo makes it immune to App's ~1 Hz snapshot
// re-renders; its data refreshes on its own 60 s poll.
export const RunwayCard = memo(function RunwayCard() {
  // v1.176.0 — usePolled: a failed refresh keeps the last projection but the card now says
  // how old it is. It used to set an error flag that was only read before the FIRST
  // success, so a runway computed hours ago rendered exactly like a live one.
  const { data: runway, lastOkAt, failing: err } = usePolled<RunwayProjection>('api/runway', RUNWAY_POLL_MS);
  const now = useNow(15_000);
  const stale = runway != null && pollStale(lastOkAt, now, RUNWAY_POLL_MS);

  if (!runway) {
    return (
      <div className="card text-sm text-muted">
        {err ? 'Off-grid runway unavailable — see add-on log.' : 'Computing off-grid runway…'}
      </div>
    );
  }
  if (runway.unavailable) {
    return (
      <div className="card text-sm">
        <div className="card-title">Off-grid runway</div>
        <div className="text-muted">{runway.unavailable}</div>
      </div>
    );
  }

  // v1.52.0 — when the pool is ALREADY at/under the floor, "N h until the
  // reserve floor" is false on its face: that crossing is the *next* one, after
  // the modelled solar recharge. Lead with the present state and re-label the
  // projection, rather than printing a number that contradicts the pool.
  const below = runway.belowReserveFloor === true;
  // v1.177.0 — "carrying the load" only when grid power is actually FLOWING. `backstopping`
  // is grid PRESENCE (gridState.ts): it was true with 0 W imported while solar carried the
  // house, and the card said "grid is carrying the load" beside an Energy flow card reading
  // GRID STANDBY. Present-but-idle is a backstop; islanded gets no note, because then these
  // projections ARE the live countdown.
  const gridFlowing = runway.grid?.importLive === true;
  const gridAvailable = runway.grid?.present === true || runway.grid?.backstopping === true;
  const headlineHours = below
    ? null
    : (runway.hoursToReserve ?? runway.hoursToEmpty);
  const headlineLabel = below
    ? (runway.hoursToReserve != null
        ? `pool is at/under the reserve floor — islanded, it would recover on today's forecast solar and fall back through the floor in ${runway.hoursToReserve.toFixed(1)} h`
        : 'pool is at/under the reserve floor')
    : runway.hoursToReserve != null
      ? 'until the backup pool reaches the reserve floor'
      : runway.hoursToEmpty != null
        ? 'until the backup pool is empty'
        : holdsLabel(runway);
  const headlineColor =
    headlineHours == null
      ? (troughTight(runway) ? 'text-warn' : 'text-ok')
      : headlineHours < 4
        ? 'text-bad'
        : headlineHours < 12
          ? 'text-warn'
          : 'text-ink';

  const fmtAt = (ms: number | null): string => {
    if (ms == null) return '—';
    const d = new Date(ms);
    const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()];
    return `${wd} ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  };

  return (
    <div className="card">
      <div className="card-title flex items-center justify-between">
        <span>Off-grid runway</span>
        {stale ? (
          <StaleNote lastOkAt={lastOkAt} nowMs={now} />
        ) : (
          // v1.177.0 — name the load model actually used. The flat last-hour load drives the
          // whole horizon only in the degraded fallback; normally it is the day-of-week curve
          // (2.2× the last hour, live) with the last hour blended into the first 4 hours.
          <span
            className="text-xs text-muted normal-case tracking-normal"
            title="Load: the day-of-week load curve without predicted EV charging, with the last hour's load blended into the first 4 hours. PV: the next-24 h forecast. Islanded: as if the grid vanished now."
          >
            {runway.loadModelDegraded ? 'last-hour load' : 'typical load'} + next-{runway.horizonHours}h forecast PV
          </span>
        )}
      </div>

      {below ? (
        <div className="flex items-baseline gap-4 mb-3 flex-wrap">
          <div className="text-3xl font-bold tabular-nums text-warn">at reserve floor</div>
          <div className="text-sm text-muted">{headlineLabel}</div>
        </div>
      ) : headlineHours != null ? (
        <div className="flex items-baseline gap-4 mb-3 flex-wrap">
          <div className={`text-4xl font-bold tabular-nums ${headlineColor}`}>
            {headlineHours.toFixed(1)}
            <span className="text-2xl font-semibold ml-1">h</span>
          </div>
          <div className="text-sm text-muted">{headlineLabel}</div>
        </div>
      ) : (
        <div className="flex items-baseline gap-4 mb-3 flex-wrap">
          <div className={`text-2xl font-bold tabular-nums ${headlineColor}`}>reserve holds {runway.horizonHours} h</div>
          <div className="text-sm text-muted">{headlineLabel}</div>
        </div>
      )}

      {/* v1.52.0 — every projection on this card is ISLANDED ("if the grid
          vanished now"). While the grid is backstopping, say so, so the times
          below are never read as an imminent real-world depletion. */}
      {(gridFlowing || gridAvailable) && (
        <div className="text-xs text-muted mb-3 -mt-1">
          {gridFlowing ? 'grid is carrying the load' : 'grid available as a backstop'} — these are islanded (grid-loss) projections, not a live countdown
        </div>
      )}

      {/* v0.46.0 — surface the server's loadModelDegraded caveat: when the load
          forecast curve is degenerate (post-restart) the whole horizon falls back
          to a flat observed-load estimate, a lower-fidelity number rendered
          identically to a healthy projection. Observability only. */}
      {runway.loadModelDegraded && (
        <div className="text-xs text-warn mb-3 -mt-1">load model degraded — flat-load estimate</div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <Stat
          label="Backup now"
          value={runway.backupRemainingKwh != null ? `${runway.backupRemainingKwh.toFixed(1)} kWh` : '—'}
          sub={runway.backupFullKwh != null ? `of ${runway.backupFullKwh.toFixed(1)} full` : undefined}
        />
        <Stat
          label="Reserve floor"
          value={runway.backupReserveKwh != null ? `${runway.backupReserveKwh.toFixed(1)} kWh` : '—'}
        />
        <Stat
          label="Recent load"
          value={`${(runway.recentLoadWatts / 1000).toFixed(2)} kW`}
          sub={recentLoadCaption(runway.recentLoadBasis)}
        />
        <Stat
          label={`${runway.horizonHours}h forecast PV`}
          value={`${runway.forecastPvUsedKwh.toFixed(1)} kWh`}
          sub={`vs ${runway.loadHorizonKwh.toFixed(1)} kWh load, no EV`}
          title="Modelled load for the projection: the day-of-week curve WITHOUT predicted EV charging (the alarm path is evidence-based — a car that is really charging shows up in the recent load), with the last hour's load blended into the first 4 hours. The Solar tab's forecast load includes predicted EV charging."
        />
      </div>

      {(runway.reserveAtMs != null || runway.emptyAtMs != null) && (
        <div className="text-xs text-muted mt-3 leading-relaxed">
          {runway.reserveAtMs != null && (
            <>
              Reserve floor reached around{' '}
              <span className="text-ink font-medium">{fmtAt(runway.reserveAtMs)}</span>
            </>
          )}
          {runway.reserveAtMs != null && runway.emptyAtMs != null && ' · '}
          {runway.emptyAtMs != null && (
            <>
              empty around <span className="text-ink font-medium">{fmtAt(runway.emptyAtMs)}</span>
            </>
          )}
          .
        </div>
      )}
    </div>
  );
});

function Stat({ label, value, sub, title }: { label: string; value: string; sub?: string; title?: string }) {
  return (
    <div className="bg-panel2 border border-line rounded-md p-2" title={title}>
      <div className="text-[10px] uppercase tracking-widest text-muted">{label}</div>
      <div className="text-base font-semibold tabular-nums mt-0.5">{value}</div>
      {sub && <div className="text-[10px] text-muted mt-0.5 truncate">{sub}</div>}
    </div>
  );
}

