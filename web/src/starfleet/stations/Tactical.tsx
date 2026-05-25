/**
 * TACTICAL — defensive systems, alarms, threat assessment.
 *
 * On the TMP bridge tactical was integrated into the captain's chair
 * armrest console. We give it a full station here because alerts are
 * the operator's most critical surface. Layout:
 *
 *   - Alert condition (banner)
 *   - SHIELDS — reserve battery buffer, "tactical situation"
 *   - THREAT LIST — every active alert, severity-sorted, with categorical
 *     and device coding
 */

import { BridgePanel } from '../components/BridgePanel';
import { AlertOutcomeButtons } from '../../components/AlertOutcomeButtons';
import type { FleetSnapshot } from '../../types';
import type { Alert } from '../../types';

export function Tactical({ snapshot }: { snapshot: FleetSnapshot | null }) {
  if (!snapshot) {
    return <BridgePanel title="TACTICAL" dept="tac"><div className="sf-working">AWAITING TELEMETRY…</div></BridgePanel>;
  }
  const alerts: Alert[] = snapshot.alerts ?? [];
  const crit = alerts.filter((a) => a.severity === 'critical');
  const warn = alerts.filter((a) => a.severity === 'warning');
  const info = alerts.filter((a) => a.severity === 'info');
  const shp2 = Object.values(snapshot.devices).find((d) => d.projection?.kind === 'shp2');
  const proj: any = shp2?.projection?.kind === 'shp2' ? shp2.projection : null;
  const soc = proj?.backupBatPercent ?? null;
  const reserve = proj?.backupReserveSoc ?? null;
  const buffer = soc != null && reserve != null ? Math.max(0, soc - reserve) : null;
  return (
    <div className="space-y-3">
      {/* === Condition banner ============================================ */}
      <div>
        {crit.length > 0 ? (
          <div className="sf-alert-banner text-center">⚠ RED ALERT · {crit.length} CRITICAL CONDITION{crit.length > 1 ? 'S' : ''} ACTIVE · ALL STATIONS</div>
        ) : warn.length > 0 ? (
          <div className="sf-alert-banner sf-alert-banner--yellow text-center">⚠ YELLOW ALERT · {warn.length} CAUTION CONDITION{warn.length > 1 ? 'S' : ''} ACTIVE</div>
        ) : (
          <div className="sf-alert-banner sf-alert-banner--green text-center">● CONDITION GREEN · ALL STATIONS NOMINAL · SHIELDS NOT REQUIRED</div>
        )}
      </div>

      <div className="grid lg:grid-cols-[1fr_2fr] gap-3">
        {/* === Shields = reserve buffer ================================= */}
        <BridgePanel title="DEFLECTORS · CHARGE RESERVE" dept="tac">
          <div className="text-center">
            <div className="sf-label">DEFLECTOR INTEGRITY</div>
            <div className="sf-readout sf-readout-lg my-2" style={{
              fontSize: 56,
              color: buffer == null ? '#8c7a5c' : buffer < 5 ? '#c4242a' : buffer < 15 ? '#e89c40' : '#6fb854',
            }}>{buffer != null ? buffer.toFixed(0) : '—'}<span className="sf-readout-unit" style={{ fontSize: 16 }}>%</span></div>
            <div className="sf-label" style={{ fontSize: 9 }}>
              ENERGY BUFFER ABOVE RESERVE FLOOR
            </div>
            <div className="mt-4 pt-3 border-t border-[#5a4520] grid grid-cols-2 gap-2 text-center">
              <Stat label="CURRENT" value={`${soc != null ? soc.toFixed(0) : '—'}%`} accent="#f4e8c8" />
              <Stat label="FLOOR" value={`${reserve ?? '—'}%`} accent="#4a86c6" />
            </div>
          </div>
        </BridgePanel>

        {/* === Threat list ============================================== */}
        <BridgePanel title="ACTIVE ALARMS · THREAT LIST" subtitle={`${alerts.length} TOTAL · ${crit.length} CRIT · ${warn.length} WARN`} dept="tac">
          {alerts.length === 0 ? (
            <div className="sf-label" style={{ color: '#6fb854' }}>● NO ACTIVE ALARMS · TACTICAL POSITION HOLDING</div>
          ) : (
            <div className="space-y-1 max-h-[480px] overflow-y-auto pr-1">
              {[...crit, ...warn, ...info].map((a, i) => {
                const sevColor = a.severity === 'critical' ? '#c4242a' : a.severity === 'warning' ? '#e89c40' : '#4a86c6';
                const sevLabel = a.severity === 'critical' ? 'CRIT' : a.severity === 'warning' ? 'WARN' : 'INFO';
                return (
                  <div key={i} className="grid grid-cols-[60px_120px_1fr] gap-2 items-start px-2 py-1.5" style={{
                    background: 'rgba(20,14,8,0.6)',
                    borderLeft: `3px solid ${sevColor}`,
                  }}>
                    <span className="sf-readout" style={{ color: sevColor, fontSize: 11 }}>{sevLabel}</span>
                    <span className="sf-label" style={{ color: '#8c7a5c' }}>{(a.category ?? '—').toUpperCase()}</span>
                    <div>
                      <div style={{ color: '#f4e8c8', fontFamily: 'Antonio, sans-serif', fontWeight: 700, fontSize: 13 }}>{a.title}</div>
                      {a.detail && <div className="sf-label mt-0.5" style={{ fontSize: 10, textTransform: 'none', letterSpacing: '0.04em' }}>{a.detail}</div>}
                      {a.device && <div className="sf-label mt-0.5" style={{ fontSize: 9 }}>SOURCE · {a.device.toUpperCase()}</div>}
                      {/* v0.9.25 — operator verdict feeds the supervised-learning dataset */}
                      <div className="mt-1">
                        <AlertOutcomeButtons alertId={a.id} variant="starfleet" />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </BridgePanel>
      </div>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div>
      <div className="sf-label">{label}</div>
      <div className="sf-readout sf-readout-md" style={accent ? { color: accent } : undefined}>{value}</div>
    </div>
  );
}
