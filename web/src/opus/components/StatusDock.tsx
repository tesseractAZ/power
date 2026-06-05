/**
 * v0.9.40 — Status dock.
 *
 * macOS-style dock floating along the bottom edge of the viewport.
 * Shows live system-status pills:
 *
 *   ● CONN     ● CLOUD     ● MA     ● TTS     ● MODELS
 *
 * Each pill is monochrome with the leading dot color-coded to status.
 * Hover for a tooltip with details.
 */

import { useEffect, useState } from 'react';
import type { ConnState } from '../../useSnapshot';

interface StatusDockProps {
  conn: ConnState;
}

interface BroadcastStatus {
  supervised: boolean;
  musicAssistantAvailable: boolean;
  ttsEngine: { service: string; label: string; local: boolean } | null;
  lastBroadcastAt: number | null;
  lastOutcome: string | null;
  // v0.11.3 — optional: the server dropped `speakerGroups` in v0.9.70 (the
  // protocol-bucketing broadcast path was removed), so /api/broadcast/status
  // no longer includes it. Marked optional + guarded at the use-site below so
  // the Opus StatusDock doesn't read `.length` off undefined and crash the
  // whole bridge (which white-screened the dashboard on the Opus theme).
  speakerGroups?: Array<{ protocol: string; targets: string[] }>;
}

export function StatusDock({ conn }: StatusDockProps) {
  const [bcast, setBcast] = useState<BroadcastStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch('/api/broadcast/status');
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) setBcast(data);
      } catch {
        /* swallow */
      }
    }
    load();
    const t = window.setInterval(load, 30_000);
    return () => { cancelled = true; window.clearInterval(t); };
  }, []);

  const dpuOnline = conn === 'open';
  const dotColor = dpuOnline ? 'var(--opus-life-1)' : 'var(--color-bad)';

  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 opus-dock flex items-center gap-2">
      <DockPill
        color={dotColor}
        label={conn === 'open' ? 'CONNECTED' : conn === 'connecting' ? 'CONNECTING' : 'DISCONNECTED'}
        tooltip={`WebSocket ${conn}`}
      />
      <Divider />
      <DockPill
        color={bcast?.musicAssistantAvailable ? 'var(--opus-life-1)' : 'rgb(var(--color-muted))'}
        label={bcast?.musicAssistantAvailable ? 'MA' : 'MA·OFF'}
        tooltip={bcast?.musicAssistantAvailable ? 'Music Assistant ready' : 'Music Assistant not installed'}
      />
      <DockPill
        color={bcast?.ttsEngine ? (bcast.ttsEngine.local ? 'var(--opus-life-1)' : 'var(--opus-cosmic)') : 'rgb(var(--color-muted))'}
        label={bcast?.ttsEngine ? (bcast.ttsEngine.local ? 'TTS·LOCAL' : 'TTS·CLOUD') : 'TTS·NONE'}
        tooltip={bcast?.ttsEngine?.label ?? 'No TTS engine'}
      />
      {bcast?.speakerGroups && bcast.speakerGroups.length > 0 && (
        <DockPill
          color="var(--opus-cosmic)"
          label={`${bcast.speakerGroups.reduce((s, g) => s + g.targets.length, 0)} SPK`}
          tooltip={bcast.speakerGroups.map((g) => `${g.protocol}×${g.targets.length}`).join(' · ')}
        />
      )}
      <Divider />
      <DockTime />
    </div>
  );
}

function DockPill({ color, label, tooltip }: { color: string; label: string; tooltip?: string }) {
  return (
    <div
      className="group relative flex items-center gap-2 px-3 py-1.5 rounded-full transition-colors duration-200"
      style={{ background: 'rgba(255,255,255,0.02)' }}
      title={tooltip}
    >
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: color, boxShadow: `0 0 4px ${color}` }} />
      <span className="opus-label" style={{ fontSize: 9, letterSpacing: '0.18em' }}>{label}</span>
    </div>
  );
}

function Divider() {
  return <span style={{ width: 1, height: 16, background: 'rgba(255,255,255,0.08)' }} />;
}

function DockTime() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(t);
  }, []);
  return (
    <div className="px-3 py-1.5 font-mono tabular-nums text-xs" style={{ color: 'rgb(var(--color-muted))' }}>
      {now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' })}
    </div>
  );
}
