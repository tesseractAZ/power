import { memo } from 'react';
import { fmtWh } from '../format';
import { usePolled, useNow } from '../usePolled';
import { pollStale, dayWindowExpired } from '../freshness';
import { StaleNote } from '../components/StaleNote';

const TODAY_POLL_MS = 60_000;

interface IntegrationResult {
  wh: number;
  coverageMs: number;
  totalMs: number;
  gapMs: number;
  samples: number;
}

interface SummaryResp {
  sinceMs: number;
  untilMs: number;
  fleet: {
    pvWh: number;
    acOutWh: number;
    panelLoadWh: number;
    batteryNetWh: number;
    coverage: number;
  };
}

// v0.22.0 — zero-prop card: memo makes it immune to App's ~1 Hz snapshot
// re-renders. Its data only changes on its own 60 s poll, so the parent push
// never needs to re-render it.
export const TodaySummary = memo(function TodaySummary() {
  // v1.176.0 — a failed refresh used to `return` silently, so the card kept its last
  // payload indefinitely with nothing on screen to say so — and after midnight it kept
  // YESTERDAY's totals under "since 12:00 AM", a label that reads identically for either
  // midnight. The last payload is still shown through a blip, marked stale once it has
  // missed its polls, and dropped outright once the day it covers is over.
  const polled = usePolled<SummaryResp>('api/summary/today', TODAY_POLL_MS);
  const now = useNow(15_000);
  const data = polled.data && !dayWindowExpired(polled.data.sinceMs, now) ? polled.data : null;
  const stale = polled.data != null && pollStale(polled.lastOkAt, now, TODAY_POLL_MS);

  const coverage = data?.fleet.coverage ?? 0;
  return (
    <div className="card col-span-full">
      <div className="card-title flex items-center justify-between">
        <span>Today</span>
        {stale ? (
          <StaleNote lastOkAt={polled.lastOkAt} />
        ) : (
          <span className="text-[10px] text-muted normal-case tracking-normal">
            {data ? `${(coverage * 100).toFixed(0)}% measured · since ${new Date(data.sinceMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '—'}
          </span>
        )}
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Tile label="Solar produced" value={fmtWh(data?.fleet.pvWh)} accent="text-warn" />
        <Tile label="AC output" value={fmtWh(data?.fleet.acOutWh)} accent="text-ok" />
        <Tile label="Batteries (net)" value={fmtWh(data?.fleet.batteryNetWh)} accent={data && data.fleet.batteryNetWh > 0 ? 'text-bad' : 'text-ok'} sub={data ? (data.fleet.batteryNetWh > 0 ? 'discharged' : 'charged') : ''} />
        <Tile label="Panel load" value={fmtWh(data?.fleet.panelLoadWh)} accent="text-accent" />
      </div>
    </div>
  );
});

function Tile({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: string }) {
  return (
    <div className="bg-panel2/60 border border-line rounded-xl p-3">
      <div className="text-[10px] uppercase tracking-widest text-muted">{label}</div>
      <div className={`text-xl font-semibold mt-1 ${accent ?? ''}`}>{value}</div>
      {sub && <div className="text-xs text-muted mt-1">{sub}</div>}
    </div>
  );
}
