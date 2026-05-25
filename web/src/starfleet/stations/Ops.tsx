/**
 * OPS — operations + communications.
 *
 * The Operations officer (Decker → Uhura's TMP-era heir) monitored
 * subsystem online state, communications, and resource allocation.
 * We map that to:
 *
 *   - SUBSYSTEM PANEL: every device's online/offline + last-heard age
 *   - COMM ARRAY: cloud / MQTT / REST status
 *   - SHIP'S CHRONOMETER: uptime + cycles + stardate
 */

import { BridgePanel } from '../components/BridgePanel';
import { JellybeanArray, type JellybeanCell } from '../components/JellybeanArray';
import { BroadcastPanel } from '../components/BroadcastPanel';
import { stardate } from '../utils';
import type { FleetSnapshot, DeviceSnapshot } from '../../types';

export function Ops({ snapshot }: { snapshot: FleetSnapshot | null }) {
  if (!snapshot) {
    return <BridgePanel title="OPS" dept="ops"><div className="sf-working">AWAITING TELEMETRY…</div></BridgePanel>;
  }
  const devices = Object.values(snapshot.devices).sort((a, b) => {
    const rank = (d: DeviceSnapshot) => d.projection?.kind === 'shp2' ? 0 : (d.productName ?? '').toLowerCase().includes('delta pro ultra') ? 1 : 2;
    return rank(a) - rank(b) || a.deviceName.localeCompare(b.deviceName);
  });
  const cells: JellybeanCell[] = devices.map((d) => {
    const age = d.lastUpdated ? Date.now() - d.lastUpdated : null;
    const color: JellybeanCell['color'] = !d.online ? 'red' :
                                          age != null && age > 180_000 ? 'amber' :
                                          age != null && age > 30_000 ? 'yellow' : 'green';
    return {
      color,
      label: shortName(d.deviceName),
      title: `${d.deviceName} · ${d.online ? 'ONLINE' : 'OFFLINE'}${age != null ? ` · ${Math.round(age / 1000)}s ago` : ''}`,
    };
  });
  const onlineCount = devices.filter((d) => d.online).length;

  return (
    <div className="space-y-3">
    {/* === Shipwide intercom test (v0.9.18) ====================== */}
    <BroadcastPanel />
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_1fr] gap-3">
      {/* === Subsystem (device) status ================================ */}
      <BridgePanel title="SUBSYSTEM STATUS · FLEET INVENTORY" subtitle={`${onlineCount} / ${devices.length} ONLINE`} dept="ops">
        <JellybeanArray cells={cells} columns={Math.min(6, devices.length)} size="lg" />
        <div className="mt-4 pt-3 border-t border-[#5a4520] grid grid-cols-2 gap-3">
          <div>
            <div className="sf-label">ACTIVE NODES</div>
            <div className="sf-readout sf-readout-lg" style={{ color: '#6fb854' }}>{onlineCount}<span className="sf-readout-unit"> / {devices.length}</span></div>
          </div>
          <div>
            <div className="sf-label">REPORTING INTERVAL</div>
            <div className="sf-readout sf-readout-md">5.0<span className="sf-readout-unit">SEC</span></div>
          </div>
        </div>
      </BridgePanel>

      {/* === Comms & chronometer ====================================== */}
      <BridgePanel title="COMMUNICATIONS ARRAY · CHRONOMETER" dept="ops">
        <div className="space-y-3">
          <Row label="EXTERNAL COMM"   value="ECOFLOW CLOUD · MQTT-S"      state="green" />
          <Row label="UPLINK CARRIER"  value="api-a.ecoflow.com · ACTIVE"  state="green" />
          <Row label="DOWNLINK"        value="mqtt.ecoflow.com:8883 · SUB" state="green" />
          <Row label="LOCAL NETWORK"   value="LAN · 192.168.x.x · ACTIVE"  state="green" />
        </div>
        <div className="mt-4 pt-3 border-t border-[#5a4520] grid grid-cols-2 gap-3">
          <div>
            <div className="sf-label">STARDATE</div>
            <div className="sf-readout sf-readout-lg" style={{ color: '#e89c40' }}>{stardate()}</div>
          </div>
          <div className="text-right">
            <div className="sf-label">CHRONO · LOCAL</div>
            <div className="sf-readout sf-readout-lg">{liveClock()}</div>
          </div>
        </div>
      </BridgePanel>
    </div>
    </div>
  );
}

function Row({ label, value, state }: { label: string; value: string; state: 'green' | 'amber' | 'red' }) {
  const color = state === 'green' ? '#6fb854' : state === 'amber' ? '#e89c40' : '#c4242a';
  return (
    <div className="grid grid-cols-[160px_1fr_24px] gap-3 items-center px-2 py-1.5" style={{ background: 'rgba(20,14,8,0.55)', borderLeft: `2px solid ${color}` }}>
      <span className="sf-label">{label}</span>
      <span style={{ color: '#f4e8c8', fontFamily: 'Antonio, sans-serif', fontSize: 13 }}>{value}</span>
      <span className="sf-jellybean" style={{ ['--jb-color' as any]: color }} />
    </div>
  );
}

function shortName(name: string): string {
  const m = name.match(/(Core|Slot|MDF|BACC|SEC)\s*(\d+)/i);
  if (m) return `${m[1].slice(0, 3).toUpperCase()}${m[2]}`;
  return name.split(/\s+/).map((w) => w[0]?.toUpperCase() ?? '').join('').slice(0, 5);
}

function liveClock(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}.${String(d.getSeconds()).padStart(2, '0')}`;
}
