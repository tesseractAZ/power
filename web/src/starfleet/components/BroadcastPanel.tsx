/**
 * BROADCAST PANEL — shipwide intercom test + status.
 *
 * Lives in the OPS station. Surfaces what the broadcast system thinks
 * its config is (target list, volume, severity gate) and gives the
 * operator one-tap test buttons for each alert level so they can
 * confirm the HomePods + Sonos are wired up correctly without waiting
 * for a real alarm.
 *
 * In real plant ops you NEVER want to discover your klaxons are broken
 * during the actual emergency. This panel is the periodic-test surface
 * for that.
 */

import { useEffect, useState } from 'react';
import { apiUrl } from '../../api';
import { BridgePanel } from './BridgePanel';

interface BroadcastStatus {
  supervised: boolean;
  enabled: boolean;
  targetCount: number;
  lastBroadcastAt: number | null;
  lastLevel: 'red' | 'yellow' | 'green' | null;
  lastOutcome: 'success' | 'partial' | 'failure' | null;
  lastErrors: string[];
  config: {
    enabled: boolean;
    targets: string[];
    audioBase: string;
    volume: number;
    minSeverity: 'critical' | 'warning';
    quietHours: [number, number] | null;
    ttsService: string | null;
    sonosRestore: boolean;
  };
}

export function BroadcastPanel() {
  const [status, setStatus] = useState<BroadcastStatus | null>(null);
  const [busy, setBusy] = useState<'red' | 'yellow' | 'green' | null>(null);
  const [lastTest, setLastTest] = useState<{ at: number; level: string; ok: boolean; errors: string[] } | null>(null);

  useEffect(() => {
    let live = true;
    const fetchStatus = async () => {
      try {
        const r = await fetch(apiUrl('api/broadcast/status'));
        if (r.ok) {
          const j = await r.json();
          if (live) setStatus(j);
        }
      } catch { /* ignore */ }
    };
    fetchStatus();
    const t = window.setInterval(fetchStatus, 15_000);
    return () => { live = false; window.clearInterval(t); };
  }, []);

  const test = async (level: 'red' | 'yellow' | 'green') => {
    setBusy(level);
    try {
      const r = await fetch(apiUrl('api/broadcast/test'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ level }),
      });
      const j = await r.json();
      setLastTest({ at: Date.now(), level, ok: !!j.ok, errors: j.messages ?? [] });
    } catch (e: any) {
      setLastTest({ at: Date.now(), level, ok: false, errors: [String(e?.message ?? e)] });
    } finally {
      setBusy(null);
    }
  };

  return (
    <BridgePanel title="SHIPWIDE INTERCOM · BROADCAST TEST" dept="ops">
      {!status ? (
        <div className="sf-working">QUERYING SUBSYSTEM…</div>
      ) : !status.supervised ? (
        <div>
          <div className="sf-label" style={{ color: '#c4242a' }}>SUBSYSTEM OFFLINE</div>
          <div style={{ color: '#f4e8c8', fontFamily: 'Antonio', fontSize: 13, marginTop: 4 }}>
            Not running inside Home Assistant Supervisor. SUPERVISOR_TOKEN unavailable.
          </div>
        </div>
      ) : !status.enabled ? (
        <div>
          <div className="sf-label" style={{ color: '#8c7a5c' }}>BROADCAST · DISABLED</div>
          <div style={{ color: '#f4e8c8', fontFamily: 'Antonio', fontSize: 13, marginTop: 4 }}>
            Enable in add-on Configuration: set <span style={{ fontFamily: 'Share Tech Mono' }}>BROADCAST_ENABLED=true</span> and
            list target media_player entity IDs in <span style={{ fontFamily: 'Share Tech Mono' }}>BROADCAST_TARGETS</span>.
          </div>
        </div>
      ) : status.targetCount === 0 ? (
        <div>
          <div className="sf-label" style={{ color: '#e89c40' }}>NO TARGETS CONFIGURED</div>
          <div style={{ color: '#f4e8c8', fontFamily: 'Antonio', fontSize: 13, marginTop: 4 }}>
            Set <span style={{ fontFamily: 'Share Tech Mono' }}>BROADCAST_TARGETS</span> to a comma-separated list of media_player IDs.
          </div>
        </div>
      ) : (
        <>
          {/* === config snapshot === */}
          <div className="grid grid-cols-[140px_1fr] gap-x-3 gap-y-1.5 mb-3 text-xs" style={{ fontFamily: 'Antonio, sans-serif' }}>
            <span className="sf-label">TARGETS</span>
            <span style={{ color: '#f4e8c8' }}>{status.targetCount} speaker{status.targetCount > 1 ? 's' : ''}</span>
            {status.config.targets.slice(0, 6).map((t, i) => (
              <span key={i} style={{ gridColumn: '2', color: '#8c7a5c', fontSize: 10 }}>· {t}</span>
            ))}
            <span className="sf-label">VOLUME</span>
            <span style={{ color: '#f4e8c8' }}>{Math.round(status.config.volume * 100)}%</span>
            <span className="sf-label">MIN SEVERITY</span>
            <span style={{ color: status.config.minSeverity === 'critical' ? '#c4242a' : '#e89c40' }}>
              {status.config.minSeverity === 'critical' ? 'CRITICAL ONLY (red)' : 'WARNING + CRITICAL (yellow + red)'}
            </span>
            <span className="sf-label">QUIET HOURS</span>
            <span style={{ color: '#f4e8c8' }}>
              {status.config.quietHours
                ? `${pad2(status.config.quietHours[0])}00 – ${pad2(status.config.quietHours[1])}00 · critical bypasses`
                : 'none · always broadcast'}
            </span>
            <span className="sf-label">VERBAL TTS</span>
            <span style={{ color: '#f4e8c8' }}>
              {status.config.ttsService || <span style={{ color: '#8c7a5c' }}>klaxon only · no TTS service set</span>}
            </span>
            {status.lastBroadcastAt && (
              <>
                <span className="sf-label">LAST BROADCAST</span>
                <span style={{ color: '#f4e8c8' }}>
                  {new Date(status.lastBroadcastAt).toLocaleString()} · {status.lastLevel?.toUpperCase()} · {status.lastOutcome?.toUpperCase()}
                  {status.lastErrors.length > 0 && (
                    <div style={{ color: '#c4242a', fontSize: 10, marginTop: 2 }}>
                      {status.lastErrors.map((e, i) => <div key={i}>· {e}</div>)}
                    </div>
                  )}
                </span>
              </>
            )}
          </div>

          {/* === test buttons === */}
          <div className="pt-3 border-t border-[#5a4520]">
            <div className="sf-label mb-2">TEST SHIPWIDE TRANSMISSION</div>
            <div className="grid grid-cols-3 gap-2">
              <TestBtn label="RED ALERT" color="#c4242a" busy={busy === 'red'} onClick={() => test('red')} />
              <TestBtn label="YELLOW ALERT" color="#e89c40" busy={busy === 'yellow'} onClick={() => test('yellow')} />
              <TestBtn label="ALL CLEAR" color="#6fb854" busy={busy === 'green'} onClick={() => test('green')} />
            </div>
            {lastTest && (
              <div className="mt-3 text-xs" style={{ fontFamily: 'Antonio, sans-serif', color: lastTest.ok ? '#6fb854' : '#c4242a' }}>
                {lastTest.ok
                  ? `✓ Test transmission (${lastTest.level.toUpperCase()}) ACCEPTED by Home Assistant.`
                  : '✕ Test transmission FAILED. Check HA logs.'}
                {lastTest.errors.length > 0 && (
                  <div style={{ color: '#c4242a', fontSize: 10, marginTop: 2 }}>
                    {lastTest.errors.map((e, i) => <div key={i}>· {e}</div>)}
                  </div>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </BridgePanel>
  );
}

function pad2(n: number) { return String(n).padStart(2, '0'); }

function TestBtn({ label, color, busy, onClick }: { label: string; color: string; busy: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      style={{
        background: busy ? '#3a2c1a' : `linear-gradient(180deg, ${color} 0%, ${dim(color)} 100%)`,
        color: busy ? '#8c7a5c' : '#0a0806',
        border: '1px solid #5a4520',
        borderRadius: 3,
        padding: '0.55rem 0.5rem',
        fontFamily: 'Antonio, sans-serif',
        fontWeight: 700,
        fontSize: 11,
        letterSpacing: '0.16em',
        textTransform: 'uppercase',
        boxShadow: busy ? undefined : `inset 0 1px 0 rgb(255 255 255 / 0.25), 0 0 12px ${color}66`,
        cursor: busy ? 'not-allowed' : 'pointer',
      }}
    >
      {busy ? '◐ TRANSMITTING…' : label}
    </button>
  );
}

/** Darken a hex color by ~40% for the gradient bottom. */
function dim(hex: string): string {
  const n = parseInt(hex.replace('#', ''), 16);
  const r = Math.max(0, Math.round(((n >> 16) & 0xff) * 0.5));
  const g = Math.max(0, Math.round(((n >> 8) & 0xff) * 0.5));
  const b = Math.max(0, Math.round((n & 0xff) * 0.5));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}
