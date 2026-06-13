/**
 * v0.16.0 — Alert Console page.
 *
 * Central surface for alert-notification audio: upload your own alarm tones
 * and assign one to PREPEND each alert level's spoken announcement.
 *
 *   Critical (red) / Warning (yellow) / Advisory (green)
 *
 * Granularity is per audio LEVEL (the 4 ISA priorities collapse to these 3
 * klaxons), matching the server's render pipeline. A bad/deleted tone falls
 * back to the built-in klaxon server-side — never a silent alarm.
 *
 * Contracts (all ingress-relative via apiUrl):
 *   GET  api/chimes        → { levels, levelLabels, assignments, chimes[], maxUploadBytes }
 *   POST api/chimes?name=  → upload raw WAV body; returns the same shape + chime
 *   DELETE api/chimes/:id  → delete; auto-reverts assignments to built-in
 *   PUT  api/chime-config  → { assignments: { red|yellow|green: {kind,id?} } }
 *   GET  api/broadcast/status (read-only central view of the audio settings)
 *   Preview: new Audio(apiUrl('chimes/<id>.wav')) plays the raw tone in-browser.
 */

import { useEffect, useRef, useState } from 'react';
import { apiUrl } from '../api';

type Level = 'red' | 'yellow' | 'green';
type Assignment = { kind: 'builtin' } | { kind: 'custom'; id: string };

interface ChimeMeta {
  id: string;
  originalName: string;
  sizeBytes: number;
  durationMs: number;
  srcRate: number;
  srcChannels: number;
  srcBits: number;
  uploadedAt: number;
}

interface ConsoleResponse {
  ok: boolean;
  levels: Level[];
  levelLabels: Record<Level, string>;
  assignments: Record<Level, Assignment>;
  chimes: ChimeMeta[];
  updatedAt: number;
  maxUploadBytes: number;
  rejected?: string[];
}

interface BroadcastStatus {
  enabled?: boolean;
  targetCount?: number;
  targets?: string[];
  musicAssistantAvailable?: boolean;
  volume?: number;
  announceVolume?: number | null;
  repeat?: number;
  minSeverity?: string;
  quietHours?: [number, number] | null;
}

const LEVEL_TOKEN: Record<Level, string> = { red: 'bad', yellow: 'warn', green: 'ok' };

export function AlertConsolePanel() {
  const [data, setData] = useState<ConsoleResponse | null>(null);
  const [bcast, setBcast] = useState<BroadcastStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // a level id, 'upload', or a chime id mid-flight
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const liveRef = useRef(true);
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    liveRef.current = true;
    void load();
    // The broadcast-status central view is best-effort and non-blocking.
    fetch(apiUrl('api/broadcast/status'))
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (liveRef.current && j) setBcast(j as BroadcastStatus); })
      .catch(() => { /* optional */ });
    return () => { liveRef.current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function load() {
    try {
      const r = await fetch(apiUrl('api/chimes'));
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as ConsoleResponse;
      if (liveRef.current) { setData(j); setLoadError(null); }
    } catch (e: any) {
      if (liveRef.current) setLoadError(String(e?.message ?? e));
    }
  }

  /** Apply a server response that carries the full console shape, in one place. */
  function applyResponse(j: ConsoleResponse) {
    if (!liveRef.current) return;
    setData(j);
    if (j.rejected && j.rejected.length) setError(j.rejected.join('; '));
  }

  async function assign(level: Level, value: string) {
    setBusy(level); setError(null); setNotice(null);
    const assignment: Assignment = value === 'builtin' ? { kind: 'builtin' } : { kind: 'custom', id: value };
    try {
      const r = await fetch(apiUrl('api/chime-config'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assignments: { [level]: assignment } }),
      });
      const j = (await r.json()) as ConsoleResponse;
      applyResponse(j);
    } catch (e: any) {
      if (liveRef.current) setError(String(e?.message ?? e));
    } finally {
      if (liveRef.current) setBusy(null);
    }
  }

  async function upload(file: File) {
    if (data && file.size > data.maxUploadBytes) {
      setError(`File too large (${(file.size / 1e6).toFixed(1)} MB; max ${(data.maxUploadBytes / 1e6).toFixed(0)} MB).`);
      return;
    }
    setBusy('upload'); setError(null); setNotice(null);
    try {
      // Raw WAV body (no multipart) — the server's audio content-type parser
      // accepts it; the display name rides in the query string only.
      const r = await fetch(apiUrl(`api/chimes?name=${encodeURIComponent(file.name)}`), {
        method: 'POST',
        headers: { 'Content-Type': 'audio/wav' },
        body: file,
      });
      const j = (await r.json()) as ConsoleResponse & { error?: string; chime?: ChimeMeta };
      if (!r.ok || j.ok === false) { setError(j.error ?? `Upload failed (HTTP ${r.status})`); return; }
      applyResponse(j);
      setNotice(`Added “${j.chime?.originalName ?? file.name}”.`);
    } catch (e: any) {
      if (liveRef.current) setError(String(e?.message ?? e));
    } finally {
      if (liveRef.current) setBusy(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function remove(id: string) {
    setBusy(id); setError(null); setNotice(null);
    try {
      const r = await fetch(apiUrl(`api/chimes/${id}`), { method: 'DELETE' });
      const j = (await r.json()) as ConsoleResponse & { error?: string };
      if (!r.ok) { setError(j.error ?? `Delete failed (HTTP ${r.status})`); return; }
      applyResponse(j);
    } catch (e: any) {
      if (liveRef.current) setError(String(e?.message ?? e));
    } finally {
      if (liveRef.current) setBusy(null);
    }
  }

  function previewTone(id: string) {
    setError(null);
    const a = new Audio(apiUrl(`chimes/${id}.wav`));
    a.play().catch(() => setError('Browser blocked autoplay — click Preview again.'));
  }

  const fmtDur = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
  const fmtKb = (b: number) => `${Math.round(b / 1024)} KB`;

  if (loadError) {
    return (
      <div className="card">
        <div className="card-title">Alert Console</div>
        <div className="text-bad text-sm mt-2">Couldn’t load the console: {loadError}</div>
      </div>
    );
  }
  if (!data) return <div className="card"><div className="card-title">Alert Console</div><div className="text-muted text-sm mt-2">Loading…</div></div>;

  return (
    <div className="space-y-4">
      <div className="card">
        <div className="card-title">Alert Console — Custom Alarm Tones</div>
        <p className="text-sm text-muted mt-2 leading-relaxed">
          Upload your own alarm sound and assign one to <span className="text-ink">prepend</span> each alert level’s
          spoken announcement, in place of the built-in chime. Tones are normalized for the speakers automatically.
          A missing or deleted tone safely falls back to the built-in klaxon — an alarm is never silenced.
        </p>
        {error && <div className="text-bad text-sm mt-2">✕ {error}</div>}
        {notice && <div className="text-ok text-sm mt-2">✓ {notice}</div>}
      </div>

      {/* ─── per-level assignment ─────────────────────────────────────── */}
      <div className="card">
        <div className="card-title">Tone per alert level</div>
        <div className="mt-3 space-y-2">
          {data.levels.map((lvl) => {
            const a = data.assignments[lvl];
            const sel = a.kind === 'custom' ? a.id : 'builtin';
            const assignedTone = a.kind === 'custom' ? data.chimes.find((c) => c.id === a.id) : null;
            return (
              <div key={lvl} className="bg-panel2/60 border border-line rounded-lg p-3 flex flex-wrap items-center gap-3">
                <span className={`badge badge-${LEVEL_TOKEN[lvl]} shrink-0`}>{data.levelLabels[lvl]}</span>
                <span className="text-[10px] uppercase tracking-widest text-muted shrink-0">{lvl}</span>
                <select
                  className="bg-panel border border-line rounded px-2 py-1 text-sm text-ink min-w-[12rem]"
                  value={sel}
                  disabled={busy === lvl}
                  onChange={(e) => assign(lvl, e.target.value)}
                >
                  <option value="builtin">Built-in chime (default)</option>
                  {data.chimes.map((c) => (
                    <option key={c.id} value={c.id}>{c.originalName}</option>
                  ))}
                </select>
                {assignedTone ? (
                  <button type="button" className="badge badge-muted hover:bg-muted/20 transition-colors"
                    onClick={() => previewTone(assignedTone.id)}>
                    ▶ Preview
                  </button>
                ) : (
                  <span className="text-[11px] text-muted">synthesized klaxon</span>
                )}
                {busy === lvl && <span className="text-[11px] text-muted">saving…</span>}
              </div>
            );
          })}
        </div>
        <p className="text-[11px] text-muted mt-3 leading-relaxed">
          To hear the full chime + spoken message on your speakers, use <span className="text-ink">Alert Settings → Preview (Speakers)</span> —
          it plays the tone you assigned here. (Re-firing a live alarm won’t replay a just-changed tone for a few minutes; the storm-guard suppresses repeats.)
        </p>
      </div>

      {/* ─── tone library + upload ────────────────────────────────────── */}
      <div className="card">
        <div className="flex items-center justify-between gap-2">
          <div className="card-title">Tone library</div>
          <div>
            <input
              ref={fileRef}
              type="file"
              accept=".wav,audio/wav,audio/x-wav"
              className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }}
            />
            <button
              type="button"
              className="badge badge-ok hover:bg-ok/25 transition-colors disabled:opacity-50"
              disabled={busy === 'upload'}
              onClick={() => fileRef.current?.click()}
            >
              {busy === 'upload' ? 'uploading…' : '⬆ Upload .wav'}
            </button>
          </div>
        </div>
        <p className="text-[11px] text-muted mt-1">
          WAV only · up to {(data.maxUploadBytes / 1e6).toFixed(0)} MB · normalized to the speaker format on upload.
        </p>
        <div className="mt-3 space-y-2">
          {data.chimes.length === 0 && (
            <div className="text-sm text-muted">No tones yet — upload a short .wav to use as an alarm sound.</div>
          )}
          {data.chimes.map((c) => {
            const usedBy = data.levels.filter((l) => data.assignments[l].kind === 'custom' && (data.assignments[l] as { id: string }).id === c.id);
            return (
              <div key={c.id} className="bg-panel2/60 border border-line rounded-lg p-3 flex flex-wrap items-center gap-3">
                <span className="text-sm text-ink font-medium grow min-w-[8rem] truncate">{c.originalName}</span>
                <span className="text-[11px] text-muted shrink-0">{fmtDur(c.durationMs)} · {fmtKb(c.sizeBytes)}</span>
                {c.srcRate > 0 && (
                  <span className="text-[10px] uppercase tracking-widest text-muted shrink-0" title="Source format before normalization">
                    {Math.round(c.srcRate / 1000)}k/{c.srcBits}b/{c.srcChannels === 1 ? 'mono' : 'stereo'}
                  </span>
                )}
                {usedBy.length > 0 && (
                  <span className="text-[10px] text-accent shrink-0">
                    in use: {usedBy.map((l) => data.levelLabels[l]).join(', ')}
                  </span>
                )}
                <button type="button" className="badge badge-muted hover:bg-muted/20 transition-colors"
                  onClick={() => previewTone(c.id)}>
                  ▶ Preview
                </button>
                <button type="button" className="badge badge-bad hover:bg-bad/25 transition-colors disabled:opacity-50"
                  disabled={busy === c.id}
                  onClick={() => remove(c.id)}>
                  {busy === c.id ? '…' : 'Delete'}
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {/* ─── central view of the broadcast/notification settings ──────── */}
      {bcast && (
        <div className="card">
          <div className="card-title">Notification processing (read-only)</div>
          <p className="text-[11px] text-muted mt-1">
            These are set in the add-on configuration (Settings → Add-ons → EcoFlow Panel). Shown here for a central view.
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mt-3">
            <Kv k="Broadcasts" v={bcast.enabled ? 'enabled' : 'DISABLED'} bad={bcast.enabled === false} />
            <Kv k="Speakers" v={String(bcast.targetCount ?? bcast.targets?.length ?? 0)} />
            <Kv k="Music Assistant" v={bcast.musicAssistantAvailable ? 'available' : 'unavailable'} bad={bcast.musicAssistantAvailable === false} />
            <Kv k="Volume" v={bcast.volume != null ? `${Math.round(bcast.volume * 100)}%` : '—'} />
            <Kv k="Repeat" v={bcast.repeat != null ? `${bcast.repeat}×` : '—'} />
            <Kv k="Min severity" v={bcast.minSeverity ?? '—'} />
            <Kv k="Quiet hours" v={bcast.quietHours ? `${bcast.quietHours[0]}:00–${bcast.quietHours[1]}:00` : 'none'} />
          </div>
          {bcast.enabled === false && (
            <div className="text-warn text-xs mt-3 leading-relaxed">
              ⚠ Audible broadcasts are currently <span className="font-semibold">disabled</span> — assigned tones won’t
              play on your speakers until you set <span className="font-mono">BROADCAST_ENABLED: true</span> in the add-on config.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Kv({ k, v, bad }: { k: string; v: string; bad?: boolean }) {
  return (
    <div className="bg-panel2/60 border border-line rounded-lg p-2">
      <div className="text-[10px] uppercase tracking-widest text-muted">{k}</div>
      <div className={`text-sm font-medium ${bad ? 'text-bad' : 'text-ink'}`}>{v}</div>
    </div>
  );
}
