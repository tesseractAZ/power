/**
 * CONN — Helm + Navigation station.
 *
 * In Starfleet, Conn handles ship's heading, velocity, and ETA. We
 * translate that to the plant's "trajectory" through SOC space:
 *
 *   - HEADING — current charge/discharge direction
 *   - VELOCITY — net power (kW)
 *   - ETA — projected runway hours (to reserve, to empty, to full)
 *   - SHIELDS — backup reserve setpoint
 */

import { useEffect, useState } from 'react';
import { BridgePanel } from '../components/BridgePanel';
import { RingGauge } from '../components/RingGauge';
import { fmtKW, fmtPct } from '../utils';
import { apiUrl } from '../../api';
import type { FleetSnapshot } from '../../types';

interface RunwayData {
  hoursToReserve: number | null;
  hoursToEmpty: number | null;
  hoursToFull?: number | null;
  recentLoadWatts: number;
  forecastPvUsedKwh: number;
}

export function Conn({ snapshot }: { snapshot: FleetSnapshot | null }) {
  const [runway, setRunway] = useState<RunwayData | null>(null);
  useEffect(() => {
    let live = true;
    const fetchIt = async () => {
      try {
        const r = await fetch(apiUrl('api/runway'));
        if (!r.ok) return;
        const j = await r.json();
        if (live) setRunway(j);
      } catch {}
    };
    fetchIt();
    const t = window.setInterval(fetchIt, 60_000);
    return () => { live = false; window.clearInterval(t); };
  }, []);

  if (!snapshot) {
    return <BridgePanel title="CONN" dept="cmd"><div className="sf-working">AWAITING TELEMETRY…</div></BridgePanel>;
  }

  const shp2 = Object.values(snapshot.devices).find((d) => d.projection?.kind === 'shp2');
  const proj = shp2?.projection?.kind === 'shp2' ? (shp2.projection as any) : null;
  const dpus = Object.values(snapshot.devices)
    .filter((d) => d.projection?.kind === 'dpu' && d.online)
    .map((d) => d.projection as any);
  const totIn = dpus.reduce((s, p) => s + (p.totalInWatts ?? 0), 0);
  const totOut = dpus.reduce((s, p) => s + (p.totalOutWatts ?? 0), 0);
  const batNetW = totOut - totIn;
  const socPct = proj?.backupBatPercent ?? null;
  const reservePct = proj?.backupReserveSoc ?? null;
  const remainingKwh = proj?.backupRemainWh ? proj.backupRemainWh / 1000 : null;
  const fullKwh = proj?.backupFullCapWh ? proj.backupFullCapWh / 1000 : null;

  const heading =
    batNetW > 5 ? 'DESCENDING · DISCHARGE' :
    batNetW < -5 ? 'ASCENDING · CHARGE' :
    'HOLDING · STATION-KEEPING';

  return (
    <div className="grid lg:grid-cols-[1fr_1fr] gap-3">
      {/* === HELM block ============================================== */}
      <BridgePanel title="HELM · COURSE & VELOCITY" dept="cmd">
        <div className="grid grid-cols-2 gap-4">
          <Field label="HEADING" value={heading} large />
          <Field label="VELOCITY" value={`${fmtKW(Math.abs(batNetW))} kW`} large />
          <Field label="WARP FACTOR" value={warpFactor(batNetW)} large />
          <Field
            label="DURATION"
            /* v0.9.24 — charging fleets always have null hoursToReserve, which
             * displayed as "— HR" giving the operator no useful information.
             * When net is negative (charging) we say so explicitly. */
            value={
              runway?.hoursToReserve != null
                ? `${runway.hoursToReserve.toFixed(1)} HR`
                : batNetW < -5 ? 'CHARGING'
                : '— HR'
            }
            large
          />
        </div>
        <div className="mt-4 pt-3 border-t border-[#5a4520]">
          <div className="sf-label mb-2">FLIGHT RECORDER · SUMMARY</div>
          <div className="grid grid-cols-3 gap-3 text-center">
            <Stat label="LOAD AVG" value={fmtKW(runway?.recentLoadWatts ?? 0) + ' kW'} />
            <Stat label="PV USED" value={`${(runway?.forecastPvUsedKwh ?? 0).toFixed(1)} kWh`} />
            <Stat label="GENERATORS" value={`${dpus.length} ONLINE`} />
          </div>
        </div>
      </BridgePanel>

      {/* === NAV block (runway + SOC trajectory) ===================== */}
      <BridgePanel title="NAVIGATION · TRAJECTORY" dept="cmd">
        <div className="flex flex-col items-center">
          <RingGauge
            value={socPct ?? 0}
            setpoint={reservePct ?? undefined}
            size={220}
            centerNumber={socPct != null ? socPct.toFixed(1) : '—'}
            centerUnit="PCT CHARGE"
            centerLabel="ENERGY RESERVE"
            fillColor={socPct != null && socPct < 30 ? '#c4242a' : '#e89c40'}
          />
          <div className="grid grid-cols-3 gap-x-6 gap-y-1 mt-3 w-full text-center">
            <div>
              <div className="sf-label">REMAINING</div>
              <div className="sf-readout sf-readout-md">{remainingKwh != null ? remainingKwh.toFixed(1) : '—'}<span className="sf-readout-unit">kWh</span></div>
            </div>
            <div>
              <div className="sf-label">RESERVE FLOOR</div>
              <div className="sf-readout sf-readout-md" style={{ color: '#4a86c6' }}>{reservePct != null ? reservePct : '—'}<span className="sf-readout-unit">%</span></div>
            </div>
            <div>
              <div className="sf-label">CAPACITY</div>
              <div className="sf-readout sf-readout-md">{fullKwh != null ? fullKwh.toFixed(1) : '—'}<span className="sf-readout-unit">kWh</span></div>
            </div>
          </div>
        </div>
        <div className="mt-3 pt-3 border-t border-[#5a4520] text-center">
          <div className="sf-label mb-1">E.T.A. CALCULATIONS</div>
          <div className="grid grid-cols-2 gap-3">
            {/* v0.9.24 — when the battery is charging both runway values are
             * null, which previously rendered as "∞ HR" — technically correct
             * but unhelpful. Show "CHARGING" instead so the operator knows
             * the system is actively recovering. */}
            <div>
              <div className="sf-label" style={{ color: '#c4242a' }}>TO RESERVE FLOOR</div>
              <div className="sf-readout sf-readout-md">
                {runway?.hoursToReserve != null
                  ? <>{runway.hoursToReserve.toFixed(1)}<span className="sf-readout-unit">HR</span></>
                  : batNetW < -5
                    ? <span style={{ color: '#6fb854' }}>CHARGING</span>
                    : <>∞<span className="sf-readout-unit">HR</span></>}
              </div>
            </div>
            <div>
              <div className="sf-label" style={{ color: '#e89c40' }}>TO ZERO BANK</div>
              <div className="sf-readout sf-readout-md">
                {runway?.hoursToEmpty != null
                  ? <>{runway.hoursToEmpty.toFixed(1)}<span className="sf-readout-unit">HR</span></>
                  : batNetW < -5
                    ? <span style={{ color: '#6fb854' }}>CHARGING</span>
                    : <>∞<span className="sf-readout-unit">HR</span></>}
              </div>
            </div>
          </div>
        </div>
      </BridgePanel>
    </div>
  );
}

function Field({ label, value, large }: { label: string; value: string; large?: boolean }) {
  return (
    <div>
      <div className="sf-label">{label}</div>
      <div className={`sf-readout ${large ? 'sf-readout-md' : ''}`}>{value}</div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="sf-label">{label}</div>
      <div className="sf-readout sf-readout-md">{value}</div>
    </div>
  );
}

/**
 * The TMP-era "warp factor" is a purely cosmetic mapping from net battery
 * power to a 1-9 scale, with WARP 1 being a trickle and WARP 9 being a
 * substantial 5+ kW push. Not real engineering — just operator vocabulary.
 */
function warpFactor(batNetW: number): string {
  const abs = Math.abs(batNetW);
  if (abs < 50) return 'IMPULSE · 1/4';
  if (abs < 200) return 'WARP 1';
  if (abs < 500) return 'WARP 2';
  if (abs < 1000) return 'WARP 3';
  if (abs < 2000) return 'WARP 4';
  if (abs < 3000) return 'WARP 5';
  if (abs < 4500) return 'WARP 6';
  if (abs < 6000) return 'WARP 7';
  return 'WARP 8+';
}
