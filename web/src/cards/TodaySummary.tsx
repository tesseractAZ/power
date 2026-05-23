import { useEffect, useState } from 'react';
import { fmtWh } from '../format';

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

export function TodaySummary() {
  const [data, setData] = useState<SummaryResp | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const r = await fetch('/api/summary/today');
        if (!r.ok) return;
        const j = (await r.json()) as SummaryResp;
        if (!cancelled) setData(j);
      } catch {
        /* ignore */
      }
    };
    load();
    const t = window.setInterval(load, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, []);

  const coverage = data?.fleet.coverage ?? 0;
  return (
    <div className="card col-span-full">
      <div className="card-title flex items-center justify-between">
        <span>Today</span>
        <span className="text-[10px] text-muted normal-case tracking-normal">
          {data ? `${(coverage * 100).toFixed(0)}% measured · since ${new Date(data.sinceMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '—'}
        </span>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Tile label="Solar produced" value={fmtWh(data?.fleet.pvWh)} accent="text-warn" />
        <Tile label="AC output" value={fmtWh(data?.fleet.acOutWh)} accent="text-ok" />
        <Tile label="Batteries (net)" value={fmtWh(data?.fleet.batteryNetWh)} accent={data && data.fleet.batteryNetWh > 0 ? 'text-bad' : 'text-ok'} sub={data ? (data.fleet.batteryNetWh > 0 ? 'discharged' : 'charged') : ''} />
        <Tile label="Panel load" value={fmtWh(data?.fleet.panelLoadWh)} accent="text-accent" />
      </div>
    </div>
  );
}

function Tile({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: string }) {
  return (
    <div className="bg-panel2/60 border border-line rounded-xl p-3">
      <div className="text-[10px] uppercase tracking-widest text-muted">{label}</div>
      <div className={`text-xl font-semibold mt-1 ${accent ?? ''}`}>{value}</div>
      {sub && <div className="text-xs text-muted mt-1">{sub}</div>}
    </div>
  );
}
