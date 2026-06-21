import { memo, useEffect, useState } from 'react';
import type { RunwayProjection } from '../types';
import { apiUrl } from '../api';

/**
 * Live off-grid runway — single most actionable number during a storm.
 * Projects the backup pool hour-by-hour from the last-hour load and the
 * next-24-hour forecast PV, surfacing hours-to-reserve and hours-to-empty.
 */
// v0.22.0 — zero-prop card: memo makes it immune to App's ~1 Hz snapshot
// re-renders; its data refreshes on its own 60 s poll.
export const RunwayCard = memo(function RunwayCard() {
  const [runway, setRunway] = useState<RunwayProjection | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const r = await fetch(apiUrl('api/runway'));
        if (!live) return;
        if (r.ok) {
          setRunway(await r.json());
          setErr(false);
        } else {
          setErr(true);
        }
      } catch {
        if (live) setErr(true);
      }
    };
    load();
    const t = window.setInterval(load, 60_000);
    return () => {
      live = false;
      window.clearInterval(t);
    };
  }, []);

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

  const headlineHours = runway.hoursToReserve ?? runway.hoursToEmpty;
  const headlineLabel =
    runway.hoursToReserve != null
      ? 'until the backup pool reaches the reserve floor'
      : runway.hoursToEmpty != null
        ? 'until the backup pool is empty'
        : 'within the projection horizon — forecast PV keeps up with load';
  const headlineColor =
    headlineHours == null
      ? 'text-ok'
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
        <span className="text-xs text-muted normal-case tracking-normal">
          last-hour load + next-{runway.horizonHours}h forecast PV
        </span>
      </div>

      {headlineHours != null ? (
        <div className="flex items-baseline gap-4 mb-3 flex-wrap">
          <div className={`text-4xl font-bold tabular-nums ${headlineColor}`}>
            {headlineHours.toFixed(1)}
            <span className="text-2xl font-semibold ml-1">h</span>
          </div>
          <div className="text-sm text-muted">{headlineLabel}</div>
        </div>
      ) : (
        <div className="flex items-baseline gap-4 mb-3 flex-wrap">
          <div className="text-2xl font-bold tabular-nums text-ok">no dip in {runway.horizonHours} h</div>
          <div className="text-sm text-muted">{headlineLabel}</div>
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
          sub={runway.backupFullKwh != null ? `of ${runway.backupFullKwh.toFixed(0)} full` : undefined}
        />
        <Stat
          label="Reserve floor"
          value={runway.backupReserveKwh != null ? `${runway.backupReserveKwh.toFixed(1)} kWh` : '—'}
        />
        <Stat
          label="Recent load"
          value={`${(runway.recentLoadWatts / 1000).toFixed(2)} kW`}
          sub="1-hour average"
        />
        <Stat
          label={`${runway.horizonHours}h forecast PV`}
          value={`${runway.forecastPvUsedKwh.toFixed(1)} kWh`}
          sub={`vs ${runway.loadHorizonKwh.toFixed(1)} kWh load`}
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

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-panel2 border border-line rounded-md p-2">
      <div className="text-[10px] uppercase tracking-widest text-muted">{label}</div>
      <div className="text-base font-semibold tabular-nums mt-0.5">{value}</div>
      {sub && <div className="text-[10px] text-muted mt-0.5 truncate">{sub}</div>}
    </div>
  );
}
