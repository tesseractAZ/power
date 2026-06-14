import { memo } from 'react';
import type { DeviceSnapshot, GenericProjection } from '../types';
import { fmtPct, fmtTemp, fmtW, socColor } from '../format';

// v0.22.0 — memo skips re-renders when App re-renders without a new snapshot;
// App's useMemo keeps each `d` reference stable across those renders.
export const SmallDeviceCard = memo(function SmallDeviceCard({ d }: { d: DeviceSnapshot & { projection?: GenericProjection } }) {
  const p = d.projection;
  return (
    <div className="card">
      <div className="flex items-start justify-between mb-2">
        <div className="min-w-0">
          <div className="text-xs text-muted">{d.productName}</div>
          <div className="text-base font-semibold truncate">{d.deviceName}</div>
          <div className="text-[10px] font-mono text-muted/80 truncate">{d.sn}</div>
        </div>
        <span className={`badge ${d.online ? 'badge-ok' : 'badge-bad'}`}>{d.online ? 'online' : 'offline'}</span>
      </div>
      {!p && d.online && <ApiBlockedNote lastError={d.lastError} />}
      {!p && !d.online && d.lastError && <div className="text-xs text-bad mb-2">err: {d.lastError}</div>}
      {p && (
        <>
          {p.soc != null && (
            <div className="mb-2">
              <div className="flex items-baseline justify-between">
                <span className="text-2xl font-bold tabular-nums">{fmtPct(p.soc)}</span>
                <span className="text-xs text-muted">{fmtTemp(p.temp)}</span>
              </div>
              <div className="bar mt-1"><div className={socColor(p.soc)} style={{ width: `${p.soc}%` }} /></div>
            </div>
          )}
          <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
            <div className="kv"><span className="kv-k">In</span><span className="kv-v">{fmtW(p.inWatts ?? p.acInWatts)}</span></div>
            <div className="kv"><span className="kv-k">Out</span><span className="kv-v">{fmtW(p.outWatts ?? p.acOutWatts)}</span></div>
            {p.pvWatts != null && <div className="kv"><span className="kv-k">PV</span><span className="kv-v">{fmtW(p.pvWatts)}</span></div>}
          </div>
        </>
      )}
    </div>
  );
});

/**
 * EcoFlow's IoT Open API only exposes telemetry for Delta Pro Ultra and the SHP2.
 * Smaller / accessory devices (Delta 3 Plus, River 3 Plus, EVSE, PowerInsight,
 * Smart Generator, WAVE 2) return error 1006 on REST and don't push MQTT — they
 * are app-only. Show a compact badge instead of an endless "waiting" spinner.
 */
function ApiBlockedNote({ lastError }: { lastError?: string }) {
  const isApiBlocked = !lastError || /1006|not allowed/i.test(lastError);
  if (isApiBlocked) {
    return <span className="badge badge-muted text-[10px] inline-block">app-only device</span>;
  }
  return <span className="text-xs text-bad">err: {lastError}</span>;
}
