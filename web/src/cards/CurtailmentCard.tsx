import { useEffect, useState } from 'react';
import type { CurtailmentReport } from '../types';
import { apiUrl } from '../api';

/**
 * Solar curtailment surface (v0.9.77) — "energy you're throwing away
 * right now because batteries are full and home load is too small to
 * absorb the PV."
 *
 * Inactive state: muted card with a one-liner explaining why we're NOT
 * curtailing (the inactiveReason text), plus today's and 7-day rollups.
 * Active state: foregrounded with the current surplus watts, the
 * opportunistic loads that fit the surplus, and a 7-day-of-day
 * histogram so you can see when this typically happens.
 *
 * Re-polls every 60s — matches the server's curtailment cache TTL so
 * we're not duplicating work.
 */
export function CurtailmentCard() {
  const [r, setR] = useState<CurtailmentReport | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const res = await fetch(apiUrl('api/curtailment'));
        if (!live) return;
        if (res.ok) {
          setR(await res.json());
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

  if (!r) {
    return (
      <div className="card text-sm text-muted">
        {err ? 'Curtailment unavailable — see add-on log.' : 'Computing solar curtailment…'}
      </div>
    );
  }

  const fits = r.opportunisticLoads.filter((o) => o.fitsInSurplus);
  const headerColor = r.active ? 'badge-warn' : 'badge-ok';
  const headerLabel = r.active ? 'curtailing now' : 'not curtailing';

  return (
    <div className="card">
      <div className="card-title flex items-center justify-between">
        <span title="When SoC ≈ 100% and home load is below PV, the DPUs throttle their MPPTs to match load. Anything more would have been rejected at the panels — that's curtailment.">
          Solar curtailment
        </span>
        <span className={`badge ${headerColor} normal-case tracking-normal text-xs`}>
          {headerLabel}
        </span>
      </div>

      {r.active ? (
        <ActiveBody r={r} fits={fits} />
      ) : (
        <InactiveBody r={r} />
      )}

      <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
        <Stat label="Today lost" value={`${r.todayKwh.toFixed(2)} kWh`} />
        <Stat label="Past 7d lost" value={`${r.recent7dKwh.toFixed(2)} kWh`} />
        <Stat
          label="Hours seen"
          value={`${r.todayHours.length + r.recent7dHoursCount}`}
          subtitle="today + last 7d"
        />
      </div>

      {r.hourlyHistogram.some((b) => b.samples > 0) && (
        <Histogram histogram={r.hourlyHistogram} />
      )}

      <div className="mt-3">
        <div className="text-xs uppercase tracking-wider text-muted mb-1">
          Opportunistic loads
          {r.active && fits.length > 0 && (
            <span className="ml-1 text-emerald-700">— {fits.length} fit now</span>
          )}
        </div>
        <div className="space-y-1">
          {r.opportunisticLoads.map((o) => (
            <div
              key={o.id}
              className={`flex items-center justify-between text-xs px-2 py-1 rounded border ${
                o.fitsInSurplus ? 'border-emerald-300 bg-emerald-50' : 'border-stone-200 bg-stone-50'
              }`}
              title={o.description}
            >
              <span className="font-medium">{o.name}</span>
              <span className="font-mono">{(o.estimatedW / 1000).toFixed(1)} kW</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ActiveBody({ r, fits }: { r: CurtailmentReport; fits: any[] }) {
  const ceiling = r.current.chargeCeilingPct;
  return (
    <div className="mt-2">
      <div className="text-3xl font-bold text-amber-700 font-mono">
        ~{r.currentSurplusW} W
      </div>
      <div className="text-xs text-muted mt-1">
        rejected at the panels right now
      </div>
      <div className="mt-2 text-xs text-muted leading-relaxed">
        Batteries{' '}
        {ceiling != null ? (
          <>at their <span className="font-mono">{ceiling}%</span> charge limit (</>
        ) : (
          'at '
        )}
        <span className="font-mono">{r.current.socAvg}%</span>
        {ceiling != null ? ') SoC' : ' SoC'},{' '}
        arrays producing <span className="font-mono">{r.current.pvActualW} W</span>{' '}
        of <span className="font-mono">{r.current.pvExpectedW ?? '—'} W</span> expected
        at <span className="font-mono">{r.current.ghiWm2 ?? '—'} W/m²</span> GHI.{' '}
        Home load <span className="font-mono">{r.current.loadW} W</span>.
      </div>
      {ceiling != null && ceiling < 100 && (
        <div className="mt-1 text-xs text-muted italic">
          Raising the charge limit or enabling Storm Guard would absorb more before curtailing.
        </div>
      )}
      {fits.length > 0 && (
        <div className="mt-2 text-xs text-emerald-800">
          Could absorb with: {fits.map((o) => o.name).join(', ')}.
        </div>
      )}
    </div>
  );
}

function InactiveBody({ r }: { r: CurtailmentReport }) {
  const reason = inactiveReasonText(r.inactiveReason, r.current.chargeCeilingPct);
  const ceiling = r.current.chargeCeilingPct;
  return (
    <div className="mt-2 text-xs text-muted leading-relaxed">
      <div>{reason}</div>
      <div className="mt-1">
        SoC <span className="font-mono">{r.current.socAvg}%</span>
        {ceiling != null && (
          <> / <span className="font-mono">{ceiling}%</span> limit</>
        )},
        PV <span className="font-mono">{r.current.pvActualW} W</span>
        {r.current.pvExpectedW != null && (
          <> of <span className="font-mono">{r.current.pvExpectedW} W</span> expected</>
        )}
        , load <span className="font-mono">{r.current.loadW} W</span>.
      </div>
    </div>
  );
}

function inactiveReasonText(
  reason: CurtailmentReport['inactiveReason'],
  ceiling: number | null,
): string {
  const limitPhrase = ceiling != null ? `${ceiling}% charge limit` : 'configured charge limit';
  switch (reason) {
    case 'soc-too-low': return `Batteries below the ${limitPhrase} — every watt is being absorbed.`;
    case 'pv-too-low': return 'PV is too low to matter right now.';
    case 'no-daylight': return 'Outside meaningful daylight — no curtailment possible.';
    case 'no-model': return 'Bayesian solar posterior doesn\'t yet have enough samples for this hour. Will fill in as the day progresses.';
    case 'small-gap': return 'Expected and actual PV are close — no meaningful surplus.';
    case 'pv-exceeds-load': return 'PV is meaningfully above load — energy is flowing through to the home, not being rejected.';
    case 'no-shp2': return 'No SHP2 in this snapshot — curtailment requires the home panel.';
    case 'no-home-dpus': return 'No SHP2-connected DPUs identified yet.';
    case null: return 'Active.';
  }
}

function Stat({ label, value, subtitle }: { label: string; value: string; subtitle?: string }) {
  return (
    <div className="border rounded px-2 py-1 bg-stone-50">
      <div className="text-[10px] uppercase tracking-wider text-muted">{label}</div>
      <div className="text-sm font-mono">{value}</div>
      {subtitle && <div className="text-[10px] text-muted">{subtitle}</div>}
    </div>
  );
}

function Histogram({ histogram }: { histogram: CurtailmentReport['hourlyHistogram'] }) {
  const peak = Math.max(1, ...histogram.map((b) => b.avgSurplusW));
  return (
    <div className="mt-3">
      <div className="text-xs uppercase tracking-wider text-muted mb-1">
        When this happens (past 7d)
      </div>
      <div className="flex gap-[2px] items-end h-12">
        {histogram.map((b) => {
          const h = b.samples > 0 ? Math.max(4, Math.round((b.avgSurplusW / peak) * 48)) : 0;
          const isMidday = b.hour >= 10 && b.hour <= 14;
          return (
            <div
              key={b.hour}
              className="flex-1 rounded-t"
              style={{
                height: `${h}px`,
                backgroundColor: b.samples === 0 ? '#e5e7eb' : isMidday ? '#d97706' : '#f59e0b',
                opacity: b.samples === 0 ? 0.3 : 1,
              }}
              title={`${String(b.hour).padStart(2, '0')}:00 — ${b.samples} samples, avg ${b.avgSurplusW} W`}
            />
          );
        })}
      </div>
      <div className="flex justify-between text-[9px] text-muted mt-1">
        <span>00</span>
        <span>06</span>
        <span>12</span>
        <span>18</span>
        <span>24</span>
      </div>
    </div>
  );
}
