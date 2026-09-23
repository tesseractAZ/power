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
  /** v1.176.0 — the local midnight that ends this payload's day (server clock). */
  dayEndMs?: number;
  fleet: {
    pvWh: number;
    acOutWh: number;
    panelLoadWh: number;
    batteryNetWh: number;
    coverage: number;
    /** v1.182.0 — home series only (see aggregator.ts); absent from older servers. */
    homeCoverage?: number;
    panelLoadCoverage?: number;
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
  // The day boundary is a server-clock time; the payload's own `untilMs` (server "now" when
  // it was computed) plus the time elapsed here since it arrived estimates the server's now
  // without trusting the browser's clock.
  const serverNow = polled.data && polled.lastOkAt != null ? polled.data.untilMs + (now - polled.lastOkAt) : now;
  const data = polled.data && !dayWindowExpired(polled.data, serverNow) ? polled.data : null;
  const stale = polled.data != null && pollStale(polled.lastOkAt, now, TODAY_POLL_MS);

  // v1.182.0 — the series behind THESE figures (home Cores + the panel), not every device's.
  const coverage = data?.fleet.homeCoverage ?? data?.fleet.coverage ?? 0;
  const panelUnmeasured = data?.fleet.panelLoadCoverage === 0;
  return (
    <div className="card col-span-full">
      <div className="card-title flex items-center justify-between">
        <span>Today</span>
        {stale ? (
          <StaleNote lastOkAt={polled.lastOkAt} nowMs={now} />
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
        <Tile label="Panel load" value={panelUnmeasured ? '—' : fmtWh(data?.fleet.panelLoadWh)} accent="text-accent" sub={panelUnmeasured ? 'not measured today' : undefined} />
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
