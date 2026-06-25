/**
 * v0.19.0 — Unified Alert Console.
 *
 * One page for ALL alert-audio administration (merges the former Alert Settings
 * + Alert Console tabs):
 *
 *   1. Broadcast master controls — turn audible broadcasts on/off and set the
 *      volume LIVE (v0.18.0 /api/broadcast/config; env is the baseline, the
 *      override wins and persists).
 *   2. Annunciation — per-ISA-priority on/off switches (with the Critical-
 *      silence confirm), chime-repeat, and per-priority preview.
 *   3. Tone per alert level — assign the level's default klaxon, a named
 *      built-in tone (v0.17.0 library), or an uploaded custom tone; each
 *      previewable in the browser.
 *   4. Tone library — upload / list / delete custom .wav tones.
 *
 * THREE independent state objects, each bound to its own endpoint and replaced
 * wholesale on its own PUT — never merged, so one section's response can't
 * clobber another's:
 *   settings ← GET/PUT api/alert-settings   { priorities[], chimeRepeat }
 *   data     ← GET/PUT api/chimes,chime-config { levels, assignments, chimes[], builtinTones[] }
 *   bcastCfg ← GET/PUT api/broadcast/config  { enabled, volume, override, envBaseline, ... }
 *
 * All URLs are ingress-relative via apiUrl(). A bad/deleted/removed tone falls
 * back to the level klaxon server-side — an alarm is never silenced.
 */

import { useEffect, useRef, useState } from 'react';
import { apiUrl } from '../api';
import { ALARM_PRIORITY_ORDER, PRIORITY_META, type AlarmPriority } from '../alertPriority';

/* ─── types ────────────────────────────────────────────────────────── */

type Level = 'red' | 'yellow' | 'green';
type Assignment = { kind: 'builtin' } | { kind: 'named'; id: string } | { kind: 'custom'; id: string };

interface ChimeMeta {
  id: string; originalName: string; sizeBytes: number; durationMs: number;
  srcRate: number; srcChannels: number; srcBits: number; uploadedAt: number;
}
interface BuiltinTone { id: string; displayName: string }

interface ConsoleResponse {
  ok: boolean;
  levels: Level[];
  levelLabels: Record<Level, string>;
  assignments: Record<Level, Assignment>;
  chimes: ChimeMeta[];
  builtinTones: BuiltinTone[];
  updatedAt: number;
  maxUploadBytes: number;
  rejected?: string[];
}

interface PriorityRow {
  id: AlarmPriority; label: string; isa: string; rank: number; tag: string;
  colorToken: string; description: string; response: string; enabled: boolean;
}
interface AlertSettingsResponse { priorities: PriorityRow[]; chimeRepeat: number; chimeRepeatDefault: number; updatedAt: number }

type PreviewTarget = 'browser' | 'speakers';
interface PreviewResponse {
  ok: boolean; spokenText: string; audioPath?: string; played: 'browser' | 'speakers';
  error?: string; cooldownRemainingMs?: number;
}
interface PreviewState { busy: boolean; status?: string; spokenText?: string; error?: string }

interface BroadcastConfigResponse {
  enabled: boolean;
  volume: number;
  announceVolume: number | null;
  announceVolumePinned: boolean;
  source: string;
  updatedAt: number;
  override: { enabled: boolean | null; volume: number | null };
  envBaseline: { enabled: boolean; volume: number };
}

const LEVEL_TOKEN: Record<Level, string> = { red: 'bad', yellow: 'warn', green: 'ok' };
const KLAXON_FILE: Record<Level, string> = { red: 'red-alert', yellow: 'yellow-alert', green: 'all-clear' };

/* ─── component ────────────────────────────────────────────────────── */

export function AlertConsolePanel() {
  // chime/tone config + library
  const [data, setData] = useState<ConsoleResponse | null>(null);
  // per-priority annunciation settings
  const [settings, setSettings] = useState<AlertSettingsResponse | null>(null);
  // broadcast master (enable + volume)
  const [bcastCfg, setBcastCfg] = useState<BroadcastConfigResponse | null>(null);

  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // a level id, 'upload', a chime id, 'bcast', or 'chime'/priority id
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<AlarmPriority | 'chime' | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [target, setTarget] = useState<PreviewTarget>('browser');
  const [preview, setPreview] = useState<Partial<Record<AlarmPriority, PreviewState>>>({});
  const [confirmDisableCritical, setConfirmDisableCritical] = useState(false);
  const [volDraft, setVolDraft] = useState<number | null>(null); // slider position while dragging (0..100)

  const liveRef = useRef(true);
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    liveRef.current = true;
    void loadChimes();
    void loadSettings();
    void loadBcast();
    return () => { liveRef.current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadChimes() {
    try {
      const r = await fetch(apiUrl('api/chimes'));
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as ConsoleResponse;
      if (liveRef.current) { setData(j); setLoadError(null); }
    } catch (e: any) {
      if (liveRef.current) setLoadError(String(e?.message ?? e));
    }
  }
  async function loadSettings() {
    try {
      const r = await fetch(apiUrl('api/alert-settings'));
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as AlertSettingsResponse;
      if (liveRef.current) setSettings(j);
    } catch { /* the annunciation section just won't render */ }
  }
  async function loadBcast() {
    try {
      const r = await fetch(apiUrl('api/broadcast/config'));
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as BroadcastConfigResponse;
      if (liveRef.current) setBcastCfg(j);
    } catch { /* master controls just won't render */ }
  }

  function applyConsole(j: ConsoleResponse) {
    if (!liveRef.current) return;
    setData(j);
    if (j.rejected && j.rejected.length) setError(j.rejected.join('; '));
  }

  /* ── broadcast master controls ─────────────────────────────────────── */

  async function putBcast(patch: { enabled?: boolean | null; volume?: number | null }) {
    setBusy('bcast'); setError(null); setNotice(null);
    try {
      const r = await fetch(apiUrl('api/broadcast/config'), {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as BroadcastConfigResponse;
      if (liveRef.current) setBcastCfg(j);
    } catch (e: any) {
      if (liveRef.current) setError(String(e?.message ?? e));
    } finally {
      if (liveRef.current) { setBusy(null); setVolDraft(null); }
    }
  }

  /* ── per-priority annunciation (lifted from Alert Settings) ─────────── */

  const putSettings = async (
    patch: { priorityEnabled?: Partial<Record<AlarmPriority, boolean>>; chimeRepeat?: number },
    saving: AlarmPriority | 'chime',
  ) => {
    setSavingId(saving); setSaveError(null);
    try {
      const r = await fetch(apiUrl('api/alert-settings'), {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as AlertSettingsResponse;
      if (liveRef.current) setSettings(j);
    } catch (e: any) {
      if (liveRef.current) setSaveError(String(e?.message ?? e));
    } finally {
      if (liveRef.current) setSavingId(null);
    }
  };
  const toggle = (row: PriorityRow) => {
    if (row.id === 'critical' && row.enabled) { setConfirmDisableCritical(true); return; }
    putSettings({ priorityEnabled: { [row.id]: !row.enabled } }, row.id);
  };
  const confirmCriticalOff = () => {
    setConfirmDisableCritical(false);
    putSettings({ priorityEnabled: { critical: false } }, 'critical');
  };
  const setChime = (n: number) => {
    const clamped = Math.max(1, Math.min(4, Math.round(n)));
    if (settings && clamped === settings.chimeRepeat) return;
    putSettings({ chimeRepeat: clamped }, 'chime');
  };

  const runPreview = async (row: PriorityRow) => {
    setPreview((p) => ({ ...p, [row.id]: { busy: true, status: 'Preparing…' } }));
    try {
      const r = await fetch(apiUrl('api/alert-preview'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ priority: row.id, target }),
      });
      const j = (await r.json()) as PreviewResponse;
      if (!liveRef.current) return;
      if (!j.ok) {
        const cd = typeof j.cooldownRemainingMs === 'number' && j.cooldownRemainingMs > 0
          ? ` (cooldown ${Math.ceil(j.cooldownRemainingMs / 1000)}s)` : '';
        setPreview((p) => ({ ...p, [row.id]: { busy: false, error: (j.error ?? 'Preview failed') + cd, spokenText: j.spokenText } }));
        return;
      }
      if (target === 'browser' && j.audioPath) {
        const a = new Audio(apiUrl(j.audioPath));
        setPreview((p) => ({ ...p, [row.id]: { busy: false, status: 'Playing…', spokenText: j.spokenText } }));
        a.play().catch(() => {
          if (liveRef.current) setPreview((p) => ({ ...p, [row.id]: { busy: false, error: 'Browser blocked autoplay — click again', spokenText: j.spokenText } }));
        });
      } else if (target === 'speakers') {
        setPreview((p) => ({ ...p, [row.id]: { busy: false, status: 'Broadcasting to speakers…', spokenText: j.spokenText } }));
      } else {
        setPreview((p) => ({ ...p, [row.id]: { busy: false, status: 'Ready', spokenText: j.spokenText } }));
      }
    } catch (e: any) {
      if (liveRef.current) setPreview((p) => ({ ...p, [row.id]: { busy: false, error: String(e?.message ?? e) } }));
    }
  };

  /* ── tone assignment + library ─────────────────────────────────────── */

  async function assign(level: Level, value: string) {
    setBusy(level); setError(null); setNotice(null);
    let assignment: Assignment;
    if (value.startsWith('named:')) assignment = { kind: 'named', id: value.slice(6) };
    else if (value.startsWith('custom:')) assignment = { kind: 'custom', id: value.slice(7) };
    else assignment = { kind: 'builtin' };
    try {
      const r = await fetch(apiUrl('api/chime-config'), {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assignments: { [level]: assignment } }),
      });
      const j = (await r.json()) as ConsoleResponse;
      applyConsole(j);
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
      const r = await fetch(apiUrl(`api/chimes?name=${encodeURIComponent(file.name)}`), {
        method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: file,
      });
      const j = (await r.json()) as ConsoleResponse & { error?: string; chime?: ChimeMeta };
      if (!r.ok || j.ok === false) { setError(j.error ?? `Upload failed (HTTP ${r.status})`); return; }
      applyConsole(j);
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
      applyConsole(j);
    } catch (e: any) {
      if (liveRef.current) setError(String(e?.message ?? e));
    } finally {
      if (liveRef.current) setBusy(null);
    }
  }

  async function playUrl(url: string) {
    setError(null);
    // Precheck the asset exists — a deleted/reassigned tone now hard-404s
    // (server SPA fallback no longer masks it as HTML 200). Distinguish a
    // genuinely-missing file from a browser autoplay block.
    try {
      const head = await fetch(url, { method: 'HEAD' });
      if (!head.ok) {
        setError('Tone file missing — reassign or re-upload');
        return;
      }
    } catch {
      setError('Tone file missing — reassign or re-upload');
      return;
    }
    new Audio(url).play().catch(() => setError('Browser blocked autoplay — click Preview again.'));
  }
  function previewAssigned(level: Level, a: Assignment) {
    if (a.kind === 'named') return playUrl(apiUrl(`audio/${a.id}.wav`));
    if (a.kind === 'custom') return playUrl(apiUrl(`chimes/${a.id}.wav`));
    return playUrl(apiUrl(`audio/${KLAXON_FILE[level]}.wav`)); // default klaxon
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

  const rows: PriorityRow[] = settings && settings.priorities.length > 0
    ? settings.priorities
    : ALARM_PRIORITY_ORDER.map((id) => ({
        id, label: PRIORITY_META[id].label, isa: PRIORITY_META[id].isa, rank: PRIORITY_META[id].rank,
        tag: PRIORITY_META[id].tag, colorToken: '', description: PRIORITY_META[id].description,
        response: PRIORITY_META[id].response, enabled: true,
      }));
  const criticalOff = rows.some((r) => r.id === 'critical' && !r.enabled);
  const overrideActive = !!bcastCfg && (bcastCfg.override.enabled != null || bcastCfg.override.volume != null);
  const effVolPct = bcastCfg ? Math.round(bcastCfg.volume * 100) : 0;

  return (
    <div className="space-y-4">
      {/* ─── header ─────────────────────────────────────────────────── */}
      <div className="card">
        <div className="card-title flex items-center justify-between">
          <span>Alert Console</span>
          <span className="text-xs text-muted normal-case tracking-normal">broadcast · annunciation · tones</span>
        </div>
        <p className="text-sm text-muted mt-2 leading-relaxed">
          Central control for alert audio: turn broadcasts on/off and set the volume, silence or sound each ISA
          priority, and choose the tone that <span className="text-ink">prepends</span> each alert level’s spoken
          announcement. A missing or deleted tone safely falls back to the built-in klaxon — an alarm is never silenced.
        </p>
        {error && <div className="text-bad text-sm mt-2">✕ {error}</div>}
        {notice && <div className="text-ok text-sm mt-2">✓ {notice}</div>}
      </div>

      {/* ─── 1. broadcast master controls ───────────────────────────── */}
      {bcastCfg && (
        <div className="card">
          <div className="card-title">Audible broadcasts</div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-3">
            {/* enable toggle */}
            <div className="bg-panel2/60 border border-line rounded-lg p-3 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[10px] uppercase tracking-widest text-muted">Broadcasts</div>
                <div className="text-xs text-muted mt-1 leading-relaxed">
                  Play alert chimes + spoken announcements on your speakers. Takes effect within ~10 s — no restart.
                </div>
              </div>
              <button
                type="button"
                onClick={() => putBcast({ enabled: !bcastCfg.enabled })}
                disabled={busy === 'bcast'}
                role="switch"
                aria-checked={bcastCfg.enabled}
                aria-label={`Audible broadcasts ${bcastCfg.enabled ? 'on' : 'off'}`}
                className={`badge shrink-0 self-center transition-colors disabled:opacity-50 ${bcastCfg.enabled ? 'badge-ok' : 'badge-muted'}`}
              >
                {busy === 'bcast' ? '…' : bcastCfg.enabled ? 'ON' : 'OFF'}
              </button>
            </div>

            {/* volume slider */}
            <div className="bg-panel2/60 border border-line rounded-lg p-3">
              <div className="flex items-center justify-between">
                <div className="text-[10px] uppercase tracking-widest text-muted">Broadcast volume</div>
                <div className="text-sm font-bold tabular-nums">{volDraft ?? effVolPct}%</div>
              </div>
              <input
                type="range" min={0} max={100} step={1}
                value={volDraft ?? effVolPct}
                disabled={busy === 'bcast' || bcastCfg.announceVolumePinned}
                onChange={(e) => setVolDraft(Number(e.target.value))}
                onMouseUp={(e) => putBcast({ volume: Number((e.target as HTMLInputElement).value) / 100 })}
                onTouchEnd={(e) => putBcast({ volume: Number((e.target as HTMLInputElement).value) / 100 })}
                onKeyUp={(e) => { if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End') putBcast({ volume: Number((e.target as HTMLInputElement).value) / 100 }); }}
                className="w-full mt-2 accent-accent disabled:opacity-50"
                aria-label="Broadcast volume"
              />
              {bcastCfg.announceVolumePinned && (
                <div className="text-[11px] text-warn mt-1 leading-relaxed">
                  Volume is pinned by <span className="font-mono">BROADCAST_ANNOUNCE_VOLUME</span> in the add-on config —
                  this slider is informational until you clear it.
                </div>
              )}
            </div>
          </div>

          {/* override / baseline disclosure */}
          <div className="flex items-center justify-between flex-wrap gap-2 mt-3">
            <div className="text-[11px] text-muted">
              {overrideActive ? (
                <>Live override active · add-on default: <span className="text-ink">{bcastCfg.envBaseline.enabled ? 'on' : 'off'}, {Math.round(bcastCfg.envBaseline.volume * 100)}%</span></>
              ) : (
                <>Using the add-on default (Settings → Add-ons → Power).</>
              )}
            </div>
            {overrideActive && (
              <button
                type="button"
                onClick={() => putBcast({ enabled: null, volume: null })}
                disabled={busy === 'bcast'}
                className="badge badge-muted hover:bg-muted/20 transition-colors disabled:opacity-50"
              >
                Reset to add-on default
              </button>
            )}
          </div>
          {!bcastCfg.enabled && (
            <div className="text-warn text-xs mt-2 leading-relaxed">
              ⚠ Audible broadcasts are <span className="font-semibold">off</span> — assigned tones won’t play on your
              speakers until you turn them back on.
            </div>
          )}
        </div>
      )}

      {/* ─── 2. annunciation: critical-off banner ───────────────────── */}
      {criticalOff && (
        <div className="card border border-bad/55 bg-bad/10">
          <div className="flex items-start gap-2 text-sm">
            <span className="mt-1 h-2 w-2 rounded-full bg-bad inline-block shrink-0 animate-pulse" />
            <span>
              <span className="text-ink font-medium">Critical (P1) annunciation is silenced.</span>{' '}
              <span className="text-muted">Critical alarms still appear on the Alerts page but will not push, chime, or broadcast.</span>
            </span>
          </div>
        </div>
      )}

      {/* ─── 2. annunciation: chime repeat + preview target ─────────── */}
      {settings && (
        <div className="card">
          <div className="card-title">Annunciation</div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="bg-panel2/60 border border-line rounded-lg p-3">
              <div className="text-[10px] uppercase tracking-widest text-muted">Chime repeats <span className="normal-case tracking-normal opacity-70">(default {settings.chimeRepeatDefault})</span></div>
              <div className="text-xs text-muted mt-1 leading-relaxed">How many times the klaxon sounds before the spoken announcement on a new alarm.</div>
              <div className="flex items-center gap-2 mt-2">
                <button type="button" onClick={() => setChime(settings.chimeRepeat - 1)}
                  disabled={savingId === 'chime' || settings.chimeRepeat <= 1}
                  className="badge badge-muted hover:bg-muted/20 transition-colors disabled:opacity-40 text-base leading-none px-3"
                  aria-label="Decrease chime repeats">−</button>
                <span className="text-2xl font-bold tabular-nums w-8 text-center">{settings.chimeRepeat}</span>
                <button type="button" onClick={() => setChime(settings.chimeRepeat + 1)}
                  disabled={savingId === 'chime' || settings.chimeRepeat >= 4}
                  className="badge badge-muted hover:bg-muted/20 transition-colors disabled:opacity-40 text-base leading-none px-3"
                  aria-label="Increase chime repeats">+</button>
                <span className="text-[11px] text-muted ml-1">min 1 · max 4</span>
              </div>
            </div>
            <div className="bg-panel2/60 border border-line rounded-lg p-3">
              <div className="text-[10px] uppercase tracking-widest text-muted">Preview target</div>
              <div className="text-xs text-muted mt-1 leading-relaxed">Where the per-priority Preview plays the announcement.</div>
              <div className="flex bg-panel border border-line rounded-lg overflow-hidden mt-2 w-max text-xs">
                <button type="button" onClick={() => setTarget('browser')}
                  className={`px-3 py-1 transition-colors ${target === 'browser' ? 'bg-accent/20 text-accent' : 'text-muted hover:text-ink'}`}>In browser</button>
                <button type="button" onClick={() => setTarget('speakers')}
                  className={`px-3 py-1 transition-colors ${target === 'speakers' ? 'bg-accent/20 text-accent' : 'text-muted hover:text-ink'}`}>On speakers</button>
              </div>
            </div>
          </div>
          {saveError && <div className="mt-3 text-xs text-bad">Could not save: {saveError}</div>}
        </div>
      )}

      {/* ─── 2. annunciation: per-priority switches + preview ───────── */}
      {settings && rows.map((row) => {
        const meta = PRIORITY_META[row.id];
        const pv = preview[row.id];
        const toggling = savingId === row.id;
        return (
          <div key={row.id} className={`card border ${meta.ring}`}>
            <div className="flex items-start gap-3">
              <span className={`mt-1.5 h-2.5 w-2.5 rounded-full inline-block shrink-0 ${meta.dot}`} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-semibold">{row.label}</span>
                  <span className={`badge ${meta.badge} text-[10px]`}>{row.label} · {row.isa}</span>
                  <span className="badge badge-muted text-[10px]">{row.response}</span>
                </div>
                <div className="text-xs text-muted mt-1 leading-relaxed">{row.description}</div>
              </div>
              <button type="button" onClick={() => toggle(row)} disabled={toggling}
                role="switch" aria-checked={row.enabled}
                aria-label={`${row.label} annunciation ${row.enabled ? 'on' : 'off'}`}
                className={`badge shrink-0 self-start transition-colors disabled:opacity-50 ${row.enabled ? 'badge-ok' : 'badge-muted'}`}>
                {toggling ? '…' : row.enabled ? 'ON' : 'OFF'}
              </button>
            </div>
            <div className="mt-3 pt-3 border-t border-line flex items-center gap-3 flex-wrap">
              <button type="button" onClick={() => runPreview(row)} disabled={pv?.busy}
                className="badge badge-muted hover:bg-muted/20 transition-colors disabled:opacity-50">
                {pv?.busy ? 'Preview…' : 'Preview ▶'}
              </button>
              <span className="text-[11px] text-muted">{target === 'browser' ? 'plays in this browser' : 'broadcasts to speakers'}</span>
              {pv?.status && <span className="text-xs text-accent">{pv.status}</span>}
              {pv?.error && <span className="text-xs text-bad">{pv.error}</span>}
            </div>
            {pv?.spokenText && (
              <div className="mt-1.5 text-xs text-muted leading-relaxed">Will announce: <span className="text-ink">“{pv.spokenText}”</span></div>
            )}
          </div>
        );
      })}

      {/* ─── 3. tone per alert level ────────────────────────────────── */}
      <div className="card">
        <div className="card-title">Tone per alert level</div>
        <p className="text-[11px] text-muted mt-1 leading-relaxed">
          Pick the default klaxon, a built-in tone, or one of your uploads to prepend each level’s announcement.
          Critical/High → red · Medium/Low → yellow · green = recovery only.
        </p>
        <div className="mt-3 space-y-2">
          {data.levels.map((lvl) => {
            const a = data.assignments[lvl];
            const sel = a.kind === 'named' ? `named:${a.id}` : a.kind === 'custom' ? `custom:${a.id}` : 'builtin';
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
                  <option value="builtin">Default (level klaxon)</option>
                  <optgroup label="Built-in tones">
                    {data.builtinTones.map((t) => (
                      <option key={t.id} value={`named:${t.id}`}>{t.displayName}</option>
                    ))}
                  </optgroup>
                  {data.chimes.length > 0 && (
                    <optgroup label="Uploaded tones">
                      {data.chimes.map((c) => (
                        <option key={c.id} value={`custom:${c.id}`}>{c.originalName}</option>
                      ))}
                    </optgroup>
                  )}
                </select>
                <button type="button" className="badge badge-muted hover:bg-muted/20 transition-colors"
                  onClick={() => previewAssigned(lvl, a)}>▶ Preview</button>
                {busy === lvl && <span className="text-[11px] text-muted">saving…</span>}
              </div>
            );
          })}
        </div>
      </div>

      {/* ─── 3b. audition the built-in tones ────────────────────────── */}
      <div className="card">
        <div className="card-title">Built-in tones</div>
        <p className="text-[11px] text-muted mt-1">Audition any system tone, then pick it for a level above.</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {data.builtinTones.map((t) => (
            <button key={t.id} type="button"
              className="badge badge-muted hover:bg-muted/20 transition-colors"
              onClick={() => playUrl(apiUrl(`audio/${t.id}.wav`))}
              title={t.id}>
              ▶ {t.displayName}
            </button>
          ))}
        </div>
      </div>

      {/* ─── 4. tone library + upload ───────────────────────────────── */}
      <div className="card">
        <div className="flex items-center justify-between gap-2">
          <div className="card-title">Tone library (your uploads)</div>
          <div>
            <input ref={fileRef} type="file" accept=".wav,audio/wav,audio/x-wav" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }} />
            <button type="button"
              className="badge badge-ok hover:bg-ok/25 transition-colors disabled:opacity-50"
              disabled={busy === 'upload'} onClick={() => fileRef.current?.click()}>
              {busy === 'upload' ? 'uploading…' : '⬆ Upload .wav'}
            </button>
          </div>
        </div>
        <p className="text-[11px] text-muted mt-1">WAV only · up to {(data.maxUploadBytes / 1e6).toFixed(0)} MB · normalized to the speaker format on upload.</p>
        <div className="mt-3 space-y-2">
          {data.chimes.length === 0 && (
            <div className="text-sm text-muted">No uploads yet — add a short .wav, or just pick a built-in tone above.</div>
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
                  <span className="text-[10px] text-accent shrink-0">in use: {usedBy.map((l) => data.levelLabels[l]).join(', ')}</span>
                )}
                <button type="button" className="badge badge-muted hover:bg-muted/20 transition-colors"
                  onClick={() => playUrl(apiUrl(`chimes/${c.id}.wav`))}>▶ Preview</button>
                <button type="button" className="badge badge-bad hover:bg-bad/25 transition-colors disabled:opacity-50"
                  disabled={busy === c.id} onClick={() => remove(c.id)}>{busy === c.id ? '…' : 'Delete'}</button>
              </div>
            );
          })}
        </div>
      </div>

      {/* ─── Critical-silence confirm modal (preserved verbatim) ────── */}
      {confirmDisableCritical && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          role="dialog" aria-modal="true" aria-label="Confirm silencing Critical annunciation">
          <div className="card max-w-md border border-bad/55">
            <div className="card-title text-bad normal-case tracking-normal text-sm">Silence Critical (P1) annunciation?</div>
            <div className="text-sm text-muted leading-relaxed mt-2">
              Critical alarms will <span className="text-ink font-medium">stay visible on the Alerts page</span>, but they
              will no longer send a push notification, sound the chime, or broadcast to the speakers. For an off-grid
              plant the push is often the only way you learn of a safety-critical alarm while away.
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button type="button" onClick={() => setConfirmDisableCritical(false)}
                className="badge badge-muted hover:bg-muted/20 transition-colors">Cancel</button>
              <button type="button" onClick={confirmCriticalOff}
                className="badge badge-bad hover:bg-bad/25 transition-colors">Silence Critical</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
