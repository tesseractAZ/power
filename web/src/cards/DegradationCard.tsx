import { useEffect, useState } from 'react';
import type { FleetDegradation, PackDegradation, DegradeStatus, RoundTripEfficiency } from '../types';

/**
 * Battery degradation — per-pack capacity-fade → end-of-life projection.
 *
 * The server regresses each pack's recorded State of Health over its full
 * history, turns the regression's slope standard error into a confidence
 * band, and extrapolates the decline to the 80%-SoH end-of-life mark. This
 * card surfaces that: the dated projection with its honest range, usage
 * intensity, lifetime throughput, and a peer comparison that flags any pack
 * wearing abnormally fast for its sibling group.
 */

const STATUS_BADGE: Record<DegradeStatus, string> = {
  projecting: 'bg-accent/15 text-accent border-accent/30',
  stable: 'badge-ok',
  learning: 'badge-muted',
  'no-data': 'badge-muted',
};
const STATUS_LABEL: Record<DegradeStatus, string> = {
  projecting: 'projecting',
  stable: 'stable',
  learning: 'learning',
  'no-data': 'no data',
};

function packLabel(p: PackDegradation): string {
  return p.coreNum != null ? `Core ${p.coreNum} · Pack ${p.packNum}` : `${p.device} · Pack ${p.packNum}`;
}
function fmtEol(ts: number | null): string {
  return ts == null ? '—' : new Date(ts).toLocaleDateString([], { year: 'numeric', month: 'short' });
}
/** The end-of-life confidence band, in years — the regression's ±1σ slope range. */
function fmtRange(p: PackDegradation): string | null {
  if (p.yearsToEolLow == null) return null;
  return p.yearsToEolHigh != null
    ? `${p.yearsToEolLow.toFixed(1)}–${p.yearsToEolHigh.toFixed(1)} yr`
    : `≥ ${p.yearsToEolLow.toFixed(1)} yr`;
}
function sumDefined(xs: Array<number | null>): number | null {
  const v = xs.filter((x): x is number => x != null);
  return v.length ? v.reduce((s, x) => s + x, 0) : null;
}
function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function DegradationCard() {
  const [deg, setDeg] = useState<FleetDegradation | null>(null);
  const [rte, setRte] = useState<RoundTripEfficiency | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const [rD, rR] = await Promise.all([
          fetch('/api/degradation'),
          fetch('/api/round-trip-efficiency'),
        ]);
        if (!live) return;
        if (rD.ok) setDeg(await rD.json());
        if (rR.ok) setRte(await rR.json());
        if (!rD.ok && !rR.ok) setErr(true);
        else setErr(false);
      } catch {
        if (live) setErr(true);
      }
    };
    load();
    const t = window.setInterval(load, 5 * 60_000);
    return () => {
      live = false;
      window.clearInterval(t);
    };
  }, []);

  if (!deg) {
    return (
      <div className="card text-sm text-muted">
        {err
          ? 'Degradation projection unavailable — the server did not return a report.'
          : 'Computing battery degradation projection…'}
      </div>
    );
  }

  const projecting = deg.packs.filter((p) => p.status === 'projecting');
  const others = deg.packs.filter((p) => p.status !== 'projecting');
  const soonest = projecting.reduce<PackDegradation | null>(
    (best, p) => (best == null || (p.yearsToEol ?? 1e9) < (best.yearsToEol ?? 1e9) ? p : best),
    null,
  );
  const medianFade = median(projecting.map((p) => p.fadePctPerYear ?? 0));
  const capNow = sumDefined(deg.packs.map((p) => p.currentCapacityKwh));
  const capDesign = sumDefined(deg.packs.map((p) => p.designCapacityKwh));
  const capPct = capNow != null && capDesign != null && capDesign > 0 ? (capNow / capDesign) * 100 : null;
  const outliers = projecting.filter((p) => p.peerOutlier);

  return (
    <div className="card">
      <div className="card-title flex items-center justify-between">
        <span>Battery degradation · end-of-life projection</span>
        <span className="text-xs text-muted normal-case tracking-normal">{deg.packs.length} pack(s)</span>
      </div>
      <p className="text-sm text-muted leading-relaxed mb-3">
        Every pack's BMS reports a State of Health — measured usable capacity against the pack's
        original design capacity. Each pack's recorded SoH is regressed over its full history; the
        regression's slope standard error becomes a confidence band, so the decline is extrapolated
        to the {deg.eolSoh}% end-of-life mark as a dated projection <em>with an honest range</em>{' '}
        rather than a single false-precision date. A parallel cycle-count fit adds usage intensity,
        and every pack's fade rate is compared against the fleet to flag one wearing abnormally fast.
      </p>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3 mb-4">
        <Tile
          label="Packs projecting"
          value={`${projecting.length} / ${deg.packs.length}`}
          sub={others.length ? `${others.length} still gathering data` : undefined}
        />
        <Tile
          label="Soonest EOL"
          value={soonest ? fmtEol(soonest.eolDate) : '—'}
          sub={soonest ? `${packLabel(soonest)} · ~${soonest.yearsToEol} yr` : 'none projected yet'}
          accent={soonest ? 'text-warn' : undefined}
        />
        <Tile
          label="Median fade rate"
          value={medianFade != null ? `${medianFade.toFixed(1)} %/yr` : '—'}
          sub={medianFade != null ? 'across projecting packs' : 'no firm trend yet'}
        />
        <Tile
          label="Fleet capacity"
          value={capPct != null ? `${capPct.toFixed(1)}%` : '—'}
          sub={
            capNow != null && capDesign != null
              ? `${capNow.toFixed(1)} / ${capDesign.toFixed(1)} kWh of design`
              : 'capacity not reported'
          }
          accent={capPct != null ? (capPct < 90 ? 'text-warn' : 'text-ok') : undefined}
        />
        <Tile
          label="Round-trip eff."
          value={rte?.efficiencyPct != null ? `${rte.efficiencyPct.toFixed(1)}%` : '—'}
          sub={
            rte != null && rte.daysWithData > 0
              ? `${rte.daysWithData}/${rte.windowDays}-day rolling · healthy ≈ 95–97%`
              : 'gathering data — needs charge/discharge cycles'
          }
          accent={
            rte?.efficiencyPct != null
              ? rte.efficiencyPct < 90
                ? 'text-warn'
                : 'text-ok'
              : undefined
          }
        />
      </div>

      {outliers.length > 0 && (
        <div className="border border-warn/55 bg-warn/10 rounded-md px-3 py-2 text-sm mb-4">
          <span className="text-[10px] uppercase tracking-widest text-warn mr-2">Peer outlier</span>
          {outliers.map((p) => packLabel(p)).join(', ')} {outliers.length === 1 ? 'is' : 'are'} fading
          materially faster than {outliers.length === 1 ? 'its' : 'their'} sibling packs — see the
          projection detail below.
        </div>
      )}

      {deg.packs.length === 0 ? (
        <div className="text-sm text-muted">No battery packs discovered.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs tabular-nums">
            <thead>
              <tr className="text-muted text-left">
                <th className="font-medium py-1 pr-4">Pack</th>
                <th className="font-medium py-1 pr-4">SoH</th>
                <th className="font-medium py-1 pr-4">Capacity now</th>
                <th className="font-medium py-1 pr-4">Cycles</th>
                <th className="font-medium py-1 pr-4">Fade / yr</th>
                <th className="font-medium py-1 pr-4">Projected EOL</th>
                <th className="font-medium py-1 pr-4">Service left</th>
                <th className="font-medium py-1">Confidence</th>
              </tr>
            </thead>
            <tbody>
              {deg.packs.map((p) => (
                <PackRow key={`${p.sn}-${p.packNum}`} p={p} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {projecting.length > 0 && (
        <>
          <div className="text-xs uppercase tracking-widest text-muted mt-4 mb-2">Projection detail</div>
          <div className="space-y-2">
            {projecting.map((p) => (
              <PackDetail key={`${p.sn}-${p.packNum}-d`} p={p} />
            ))}
          </div>
        </>
      )}

      {others.length > 0 && (
        <>
          <div className="text-xs uppercase tracking-widest text-muted mt-4 mb-1.5">
            Packs not yet projecting
          </div>
          <div className="space-y-1 text-xs">
            {others.map((p) => (
              <div key={`${p.sn}-${p.packNum}-n`} className="flex gap-3">
                <span className="text-ink font-medium shrink-0 w-28">{packLabel(p)}</span>
                <span className="text-muted leading-relaxed">{p.summary}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function PackRow({ p }: { p: PackDegradation }) {
  const sohColor =
    p.currentSoh == null
      ? 'text-muted'
      : p.currentSoh >= 95
        ? 'text-ok'
        : p.currentSoh >= 88
          ? 'text-ink'
          : p.currentSoh >= 82
            ? 'text-warn'
            : 'text-bad';
  const yearsColor =
    p.yearsToEol == null
      ? 'text-muted'
      : p.yearsToEol < 2
        ? 'text-bad'
        : p.yearsToEol < 5
          ? 'text-warn'
          : 'text-ink';
  const range = fmtRange(p);
  return (
    <tr className={`border-t border-line/50 ${p.peerOutlier ? 'bg-warn/5' : ''}`}>
      <td className="py-1.5 pr-4 text-ink font-medium whitespace-nowrap">
        {packLabel(p)}
        {p.peerOutlier && <span className="badge badge-warn text-[9px] ml-1.5">fast</span>}
      </td>
      <td className={`py-1.5 pr-4 font-semibold ${sohColor}`}>
        {p.currentSoh != null ? `${p.currentSoh.toFixed(1)}%` : '—'}
      </td>
      <td className="py-1.5 pr-4 whitespace-nowrap">
        {p.currentCapacityKwh != null ? (
          <>
            {p.currentCapacityKwh.toFixed(2)} <span className="text-muted">kWh</span>
            {p.capacityFadeKwh != null && p.capacityFadeKwh > 0 && (
              <span className="text-muted"> · −{p.capacityFadeKwh.toFixed(2)}</span>
            )}
          </>
        ) : (
          '—'
        )}
      </td>
      <td className="py-1.5 pr-4 whitespace-nowrap">
        {p.cycles != null ? p.cycles.toLocaleString() : '—'}
        {p.cyclesPerYear != null && <span className="text-muted"> · {p.cyclesPerYear}/yr</span>}
      </td>
      <td className="py-1.5 pr-4 whitespace-nowrap">
        {p.fadePctPerYear != null ? (
          <>
            {p.fadePctPerYear.toFixed(1)}
            {p.fadeUncertaintyPct != null && p.fadeUncertaintyPct > 0 && (
              <span className="text-muted"> ±{p.fadeUncertaintyPct.toFixed(1)}</span>
            )}
            <span className="text-muted"> %</span>
          </>
        ) : (
          '—'
        )}
      </td>
      <td className="py-1.5 pr-4 text-ink">{fmtEol(p.eolDate)}</td>
      <td className={`py-1.5 pr-4 font-semibold ${yearsColor}`}>
        {p.yearsToEol != null ? `${p.yearsToEol.toFixed(1)} yr` : '—'}
        {range && p.yearsToEol != null && (
          <div className="text-[10px] text-muted font-normal">{range}</div>
        )}
      </td>
      <td className="py-1.5 whitespace-nowrap">
        <span className={`badge text-[9px] ${STATUS_BADGE[p.status]}`}>{STATUS_LABEL[p.status]}</span>
        {p.r2 != null && <span className="text-[10px] text-muted ml-1.5">R² {p.r2.toFixed(2)}</span>}
      </td>
    </tr>
  );
}

function PackDetail({ p }: { p: PackDegradation }) {
  const facts: Array<{ label: string; value: string }> = [
    { label: 'Current SoH', value: p.currentSoh != null ? `${p.currentSoh.toFixed(1)}%` : '—' },
    {
      label: 'Fade rate',
      value:
        p.fadePctPerYear != null
          ? `${p.fadePctPerYear.toFixed(1)}${p.fadeUncertaintyPct != null ? ` ±${p.fadeUncertaintyPct.toFixed(1)}` : ''} %/yr`
          : '—',
    },
    { label: 'Projected EOL', value: fmtEol(p.eolDate) },
    {
      label: 'Service window',
      value: fmtRange(p) ?? (p.yearsToEol != null ? `${p.yearsToEol.toFixed(1)} yr` : '—'),
    },
    {
      label: 'Usage intensity',
      value: p.cyclesPerYear != null ? `${p.cyclesPerYear} cycles/yr` : '—',
    },
    {
      label: 'Fade / 100 cycles',
      value: p.fadePctPer100Cycles != null ? `${p.fadePctPer100Cycles.toFixed(2)}%` : '—',
    },
    {
      label: 'Cycles → EOL',
      value:
        p.projectedCyclesAtEol != null
          ? `${(p.cycles ?? 0).toLocaleString()} → ~${p.projectedCyclesAtEol.toLocaleString()}`
          : p.cycles != null
            ? p.cycles.toLocaleString()
            : '—',
    },
    {
      label: 'Lifetime throughput',
      value: p.lifetimeThroughputKwh != null ? `${p.lifetimeThroughputKwh.toLocaleString()} kWh` : '—',
    },
    {
      label: 'Fit confidence',
      value: p.r2 != null ? `R² ${p.r2.toFixed(2)} · ${p.samples} pts · ${p.dataSpanDays} d` : '—',
    },
    {
      label: 'Avg pack temp',
      value: p.avgPackTempC != null ? `${p.avgPackTempC.toFixed(1)} °C` : '—',
    },
    {
      label: 'Fade @ 25 °C',
      value:
        p.fadePctPerYearAt25C != null
          ? `${p.fadePctPerYearAt25C.toFixed(1)} %/yr`
          : '—',
    },
    {
      label: 'Cool 5 °C → +yr',
      value:
        p.coolingBenefitYears != null
          ? `+${p.coolingBenefitYears.toFixed(1)} yr`
          : '—',
    },
    {
      // Coulombic efficiency — discharge mAh ÷ charge mAh across the last
      // ~7 days. Healthy LFP stays well above 99%; a drift down signals
      // side-reaction losses inside the cell that SoH alone may not yet show.
      label: 'Coulombic eff.',
      value: p.coulombicEffPct != null ? `${p.coulombicEffPct.toFixed(2)}%` : '—',
    },
  ];
  return (
    <div
      className={`bg-panel2/50 border rounded-lg p-3 ${p.peerOutlier ? 'border-warn/55' : 'border-line'}`}
    >
      <div className="flex items-baseline gap-2 flex-wrap mb-1">
        <span className="text-sm font-semibold">{packLabel(p)}</span>
        {p.peerOutlier && <span className="badge badge-warn text-[10px]">peer outlier</span>}
        {p.peerFadeRatio != null && (
          <span className="text-[11px] text-muted">{p.peerFadeRatio.toFixed(1)}× fleet-median fade</span>
        )}
      </div>
      <div className="text-xs text-muted leading-relaxed mb-2">{p.summary}</div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
        {facts.map((f) => (
          <div key={f.label} className="bg-panel border border-line rounded-md px-2 py-1.5">
            <div className="text-[9px] uppercase tracking-wider text-muted leading-none">{f.label}</div>
            <div className="text-sm font-mono font-semibold tabular-nums text-ink mt-1 leading-none">
              {f.value}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Tile({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: string }) {
  return (
    <div className="bg-panel2/60 border border-line rounded-md p-3">
      <div className="text-[10px] uppercase tracking-widest text-muted">{label}</div>
      <div className={`text-xl font-semibold mt-1 tabular-nums ${accent ?? ''}`}>{value}</div>
      {sub && <div className="text-[10px] text-muted mt-1">{sub}</div>}
    </div>
  );
}
