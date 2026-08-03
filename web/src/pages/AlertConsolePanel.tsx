/**
 * v0.19.0 — Unified Alert Console.
 *
 * v1.60.0 — REORGANISED BY ALERT CATEGORY. The page used to be laid out by
 * FUNCTION, which scattered everything about one severity across three separate
 * cards: its enable switch in "Annunciation", its tone in "Tone per alert level",
 * its spoken preview back in "Annunciation" again. An operator asking "what does
 * High do?" had to read three cards and hold the answer in their head. Now:
 *
 *   GLOBAL, above    — broadcast master (on/off, override disclosure)
 *   ONE CARD PER CATEGORY, in rung order (critical → high → medium → low → clear)
 *   GLOBAL, below    — built-in tone audition grid, uploaded tone library
 *
 * THE FOUR-VS-FIVE ASYMMETRY IS REAL AND IS NOT PAPERED OVER.
 *
 *   Tone assignment is per RUNG — five values, `clear` included; driven by
 *   `data.levels` (the server's CHIME_LEVELS).
 *   The enable switch and the spoken preview are per PRIORITY — four values;
 *   driven by `ALARM_PRIORITY_ORDER`, `settings.priorityEnabled`, and
 *   `POST /api/alert-preview`, which accepts an `AlarmPriority` only.
 *
 * There is no `priorityEnabled.clear` on the backend and no preview endpoint for
 * it, so the fifth card renders TONE-ONLY and says why on the card. Inventing a
 * dead toggle there would be a lie about what the server can do.
 *
 * THREE independent state objects, each bound to its own endpoint and replaced
 * wholesale on its own PUT — never merged, so one section's response can't
 * clobber another's:
 *   settings ← GET/PUT api/alert-settings   { priorities[] }
 *   data     ← GET/PUT api/chimes,chime-config { levels, assignments, chimes[], builtinTones[] }
 *   bcastCfg ← GET/PUT api/broadcast/config  { enabled, volume, override, envBaseline, ... }
 *
 * `settings` failing to load degrades gracefully: the category cards still render
 * and tone assignment still works — only the per-priority controls are withheld.
 *
 * All URLs are ingress-relative via apiUrl(). A bad/deleted/removed tone falls
 * back to the level klaxon server-side — an alarm is never silenced.
 */

import { useEffect, useRef, useState } from 'react';
import { type Level, LEVEL_TOKEN, KLAXON_FILE } from '../alarmLevels';
import { apiUrl } from '../api';
import { ALARM_PRIORITY_ORDER, PRIORITY_META, type AlarmPriority } from '../alertPriority';

/* ─── types ────────────────────────────────────────────────────────── */

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
interface AlertSettingsResponse { priorities: PriorityRow[]; updatedAt: number }

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
  override: { enabled: boolean | null };
  envBaseline: { enabled: boolean };
}

/**
 * Dot / ring / badge classes for a category card.
 *
 * Keyed by `LEVEL_TOKEN` — the RUNG colour vocabulary, which covers all five
 * rungs. (`PRIORITY_META` carries the same colours but only for the four
 * priorities, so it cannot dress the all-clear card.) The classes are written
 * out as LITERALS rather than interpolated: `badge-*` are hand-authored in
 * index.css and survive interpolation, but `bg-ok` / `border-ok/45` are real
 * Tailwind utilities that only get emitted if the JIT scanner sees them here.
 */
interface Accent { dot: string; ring: string; badge: string }
const ACCENT_BY_TOKEN: Record<string, Accent> = {
  bad: { dot: 'bg-bad', ring: 'border-bad/45', badge: 'badge-bad' },
  high: { dot: 'bg-high', ring: 'border-high/45', badge: 'badge-high' },
  warn: { dot: 'bg-warn', ring: 'border-warn/45', badge: 'badge-warn' },
  info: { dot: 'bg-info', ring: 'border-info/40', badge: 'badge-info' },
  ok: { dot: 'bg-ok', ring: 'border-ok/45', badge: 'badge-ok' },
};
/** A rung this build doesn't know renders neutral rather than un-styled. */
const UNKNOWN_ACCENT: Accent = { dot: 'bg-muted', ring: 'border-line', badge: 'badge-muted' };
function accentFor(level: Level): Accent {
  return ACCENT_BY_TOKEN[LEVEL_TOKEN[level]] ?? UNKNOWN_ACCENT;
}

/** The priority behind a rung, or null for rungs that have none (`clear`). */
function priorityForLevel(level: Level): AlarmPriority | null {
  return level === 'clear' ? null : level;
}

/* ─── one card per alert category ──────────────────────────────────── */

interface CategoryCardProps {
  level: Level;
  /** Server-supplied rung label, e.g. "Critical (P1)" / "All-clear / Recovery". */
  label: string;
  accent: Accent;
  /** The priority row, when this rung has one AND settings loaded. null → tone-only. */
  row: PriorityRow | null;
  /** Shown when `row` is null: WHY this card has no enable switch / spoken preview. */
  toneOnlyNote?: string;
  assignment: Assignment;
  builtinTones: BuiltinTone[];
  chimes: ChimeMeta[];
  toneBusy: boolean;
  toneError?: string;
  toggling: boolean;
  saveError?: string;
  preview?: PreviewState;
  onAssign: (value: string) => void;
  onPreviewTone: () => void;
  onToggle: () => void;
  onPreviewSpoken: (target: PreviewTarget) => void;
}

function CategoryCard(p: CategoryCardProps) {
  const a = p.assignment;
  const sel = a.kind === 'named' ? `named:${a.id}` : a.kind === 'custom' ? `custom:${a.id}` : 'builtin';
  const pv = p.preview;
  return (
    <div className={`card border ${p.accent.ring}`}>
      {/* identity + enable */}
      <div className="flex items-start gap-3">
        <span className={`mt-1.5 h-2.5 w-2.5 rounded-full inline-block shrink-0 ${p.accent.dot}`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold">{p.label}</span>
            <span className="text-[10px] uppercase tracking-widest text-muted">{p.level}</span>
            {p.row && (
              <>
                <span className={`badge ${p.accent.badge} text-[10px]`}>{p.row.tag} · {p.row.isa}</span>
                <span className="badge badge-muted text-[10px]">{p.row.response}</span>
              </>
            )}
            {/* `clear` has no priority row and never will — it is a rung, not an
              * alarm tier, so it has no ISA class and no response expectation.
              * Any OTHER row-less card is a degraded priority (settings failed to
              * load) and must NOT be dressed up as if it were the all-clear. */}
            {p.level === 'clear' && <span className="badge badge-muted text-[10px]">No ISA priority</span>}
          </div>
          {p.row && <div className="text-xs text-muted mt-1 leading-relaxed">{p.row.description}</div>}
          {p.toneOnlyNote && <div className="text-xs text-muted mt-1 leading-relaxed">{p.toneOnlyNote}</div>}
        </div>
        {p.row && (
          <button type="button" onClick={p.onToggle} disabled={p.toggling}
            role="switch" aria-checked={p.row.enabled}
            aria-label={`${p.row.label} annunciation ${p.row.enabled ? 'on' : 'off'}`}
            className={`badge shrink-0 self-start transition-colors disabled:opacity-50 ${p.row.enabled ? 'badge-ok' : 'badge-muted'}`}>
            {p.toggling ? '…' : p.row.enabled ? 'ON' : 'OFF'}
          </button>
        )}
      </div>
      {/* the enable switch raised it, so the error belongs here — not in the page header */}
      {p.saveError && <div className="mt-2 text-xs text-bad">Could not save: {p.saveError}</div>}

      {/* tone — every rung, `clear` included */}
      <div className="mt-3 pt-3 border-t border-line flex flex-wrap items-center gap-3">
        <span className="text-[10px] uppercase tracking-widest text-muted shrink-0">Tone</span>
        <select
          className="bg-panel border border-line rounded px-2 py-1 text-sm text-ink min-w-[12rem]"
          value={sel}
          disabled={p.toneBusy}
          aria-label={`Tone for ${p.label}`}
          onChange={(e) => p.onAssign(e.target.value)}
        >
          <option value="builtin">Level klaxon (default)</option>
          <optgroup label="Built-in tones">
            {p.builtinTones.map((t) => <option key={t.id} value={`named:${t.id}`}>{t.displayName}</option>)}
          </optgroup>
          {p.chimes.length > 0 && (
            <optgroup label="Uploaded tones">
              {p.chimes.map((c) => <option key={c.id} value={`custom:${c.id}`}>{c.originalName}</option>)}
            </optgroup>
          )}
        </select>
        <button type="button" className="badge badge-muted hover:bg-muted/20 transition-colors"
          onClick={p.onPreviewTone}>▶ Preview tone</button>
        {p.toneBusy && <span className="text-[11px] text-muted">saving…</span>}
      </div>
      {p.toneError && <div className="mt-2 text-xs text-bad">{p.toneError}</div>}

      {/* spoken announcement — priorities only (/api/alert-preview takes an AlarmPriority) */}
      {p.row && (
        <>
          <div className="mt-3 pt-3 border-t border-line flex items-center gap-3 flex-wrap">
            <span className="text-[10px] uppercase tracking-widest text-muted shrink-0">Announcement</span>
            <button type="button" onClick={() => p.onPreviewSpoken('browser')} disabled={pv?.busy}
              className="badge badge-muted hover:bg-muted/20 transition-colors disabled:opacity-50">
              {pv?.busy ? '…' : '▶ In browser'}
            </button>
            {/* Deliberately styled apart from the browser button: this one is
              * LOUD and house-wide. One click, no mode, no ambiguity about which
              * of the two you just pressed. */}
            <button type="button" onClick={() => p.onPreviewSpoken('speakers')} disabled={pv?.busy}
              className="badge badge-warn hover:bg-warn/20 transition-colors disabled:opacity-50"
              title="Broadcasts aloud on the house speakers">
              {pv?.busy ? '…' : '▶ On speakers'}
            </button>
            {pv?.status && <span className="text-xs text-accent">{pv.status}</span>}
            {pv?.error && <span className="text-xs text-bad">{pv.error}</span>}
          </div>
          {pv?.spokenText && (
            <div className="mt-1.5 text-xs text-muted leading-relaxed">Will announce: <span className="text-ink">“{pv.spokenText}”</span></div>
          )}
        </>
      )}
    </div>
  );
}

/* ─── component ────────────────────────────────────────────────────── */

export function AlertConsolePanel() {
  // chime/tone config + library
  const [data, setData] = useState<ConsoleResponse | null>(null);
  // per-priority annunciation settings
  const [settings, setSettings] = useState<AlertSettingsResponse | null>(null);
  // broadcast master (enable + volume)
  const [bcastCfg, setBcastCfg] = useState<BroadcastConfigResponse | null>(null);

  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // a level id, 'upload', a chime id, or 'bcast'
  const [error, setError] = useState<string | null>(null);   // page-level (upload / delete / broadcast / library audition)
  const [notice, setNotice] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<AlarmPriority | null>(null);
  // Errors that belong to ONE category are rendered on that category's card,
  // next to the control that raised them, instead of in the page header.
  const [saveError, setSaveError] = useState<Partial<Record<AlarmPriority, string>>>({});
  const [levelError, setLevelError] = useState<Partial<Record<Level, string>>>({});
  const [preview, setPreview] = useState<Partial<Record<AlarmPriority, PreviewState>>>({});
  const [confirmDisableCritical, setConfirmDisableCritical] = useState(false);

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
    } catch { /* per-priority controls degrade to tone-only; tone assignment still works */ }
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

  /** Error sink scoped to one category card. Same shape as setError. */
  const levelSink = (level: Level) => (msg: string | null) => {
    if (!liveRef.current) return;
    setLevelError((m) => ({ ...m, [level]: msg ?? undefined }));
  };

  /* ── broadcast master controls ─────────────────────────────────────── */

  async function putBcast(patch: { enabled?: boolean | null }) {
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
      if (liveRef.current) setBusy(null);
    }
  }

  /* ── per-priority annunciation ─────────────────────────────────────── */

  const putSettings = async (
    patch: { priorityEnabled?: Partial<Record<AlarmPriority, boolean>> },
    saving: AlarmPriority,
  ) => {
    setSavingId(saving);
    setSaveError((m) => ({ ...m, [saving]: undefined }));
    try {
      const r = await fetch(apiUrl('api/alert-settings'), {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as AlertSettingsResponse;
      if (liveRef.current) setSettings(j);
    } catch (e: any) {
      if (liveRef.current) setSaveError((m) => ({ ...m, [saving]: String(e?.message ?? e) }));
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

  // v1.61.0 — the target is an ARGUMENT, not ambient state. The old global
  // browser/speakers toggle was a mode: set it once, forget, then click Preview
  // on some other card and get a house-wide broadcast you did not intend. Each
  // button now names its own destination, so the click and the outcome match.
  const runPreview = async (row: PriorityRow, target: PreviewTarget) => {
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
    const sink = levelSink(level);
    setBusy(level); sink(null); setNotice(null);
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
      sink(String(e?.message ?? e));
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

  /**
   * Play a tone URL, reporting into `sink` — the page header for the global
   * library/audition buttons, or the owning category card for its own preview.
   */
  async function playUrl(url: string, sink: (msg: string | null) => void = setError) {
    sink(null);
    // Precheck the asset exists — a deleted/reassigned tone now hard-404s
    // (server SPA fallback no longer masks it as HTML 200). Distinguish a
    // genuinely-missing file from a browser autoplay block.
    try {
      const head = await fetch(url, { method: 'HEAD' });
      if (!head.ok) {
        sink('Tone file missing — reassign or re-upload');
        return;
      }
    } catch {
      sink('Tone file missing — reassign or re-upload');
      return;
    }
    new Audio(url).play().catch(() => sink('Browser blocked autoplay — click Preview again.'));
  }
  function previewAssigned(level: Level, a: Assignment) {
    const sink = levelSink(level);
    if (a.kind === 'named') return playUrl(apiUrl(`audio/${a.id}.wav`), sink);
    if (a.kind === 'custom') return playUrl(apiUrl(`chimes/${a.id}.wav`), sink);
    return playUrl(apiUrl(`audio/${KLAXON_FILE[level]}.wav`), sink); // default klaxon
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

  // Per-priority rows. ONLY populated when `settings` loaded — a failed load must
  // withhold the enable switch and spoken preview rather than render an enable
  // state we don't actually know. (When settings loaded but carries no rows, the
  // PRIORITY_META fallback keeps the taxonomy visible, as before.)
  const rows: PriorityRow[] = !settings
    ? []
    : settings.priorities.length > 0
      ? settings.priorities
      : ALARM_PRIORITY_ORDER.map((id) => ({
          id, label: PRIORITY_META[id].label, isa: PRIORITY_META[id].isa, rank: PRIORITY_META[id].rank,
          tag: PRIORITY_META[id].tag, colorToken: '', description: PRIORITY_META[id].description,
          response: PRIORITY_META[id].response, enabled: true,
        }));
  const rowById = new Map<AlarmPriority, PriorityRow>(rows.map((r) => [r.id, r]));
  const criticalOff = rows.some((r) => r.id === 'critical' && !r.enabled);
  const overrideActive = !!bcastCfg && (bcastCfg.override.enabled != null);

  return (
    <div className="space-y-4">
      {/* ─── header ─────────────────────────────────────────────────── */}
      <div className="card">
        <div className="card-title flex items-center justify-between">
          <span>Alert Console</span>
          <span className="text-xs text-muted normal-case tracking-normal">broadcast · annunciation · tones</span>
        </div>
        <p className="text-sm text-muted mt-2 leading-relaxed">
          Central control for alert audio, <span className="text-ink">one block per alert category</span>: silence or
          sound each ISA priority, choose the tone that prepends its spoken announcement, and hear exactly what it will
          say. A missing or deleted tone safely falls back to the built-in klaxon — an alarm is never silenced.
        </p>
        {/* Page-level problems only. Anything a single category raised is shown on that card. */}
        {error && <div className="text-bad text-sm mt-2">✕ {error}</div>}
        {notice && <div className="text-ok text-sm mt-2">✓ {notice}</div>}
      </div>

      {/* ─── GLOBAL: broadcast master controls ──────────────────────── */}
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

          </div>

          {/* override / baseline disclosure */}
          <div className="flex items-center justify-between flex-wrap gap-2 mt-3">
            <div className="text-[11px] text-muted">
              {overrideActive ? (
                <>Live override active · add-on default: <span className="text-ink">{bcastCfg.envBaseline.enabled ? 'on' : 'off'}</span></>
              ) : (
                <>Using the add-on default (Settings → Add-ons → Power).</>
              )}
            </div>
            {overrideActive && (
              <button
                type="button"
                onClick={() => putBcast({ enabled: null })}
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

      {/* ─── critical-silenced banner ───────────────────────────────── */}
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

      {/* ─── ONE CARD PER ALERT CATEGORY ────────────────────────────────
        * Driven by `data.levels` (the server's CHIME_LEVELS) rather than the
        * local LEVELS constant, so a rung the server gains can never go
        * silently unlisted. `alarmLevels.LEVELS` pins the expected order and
        * membership — server/test/alarmLevelWebMirror.test.ts asserts they agree. */}
      {data.levels.map((lvl) => {
        const priority = priorityForLevel(lvl);
        const row = priority ? rowById.get(priority) ?? null : null;
        const toneOnlyNote = !row
          ? priority
            ? 'Annunciation settings didn’t load, so the enable switch and spoken preview are hidden. Tone assignment still works.'
            : 'Recovery has no enable switch — an all-clear is the absence of an alarm, not one you can silence. It has no spoken preview either.'
          : undefined;
        return (
          <CategoryCard
            key={lvl}
            level={lvl}
            label={data.levelLabels[lvl] ?? lvl}
            accent={accentFor(lvl)}
            row={row}
            toneOnlyNote={toneOnlyNote}
            assignment={data.assignments[lvl]}
            builtinTones={data.builtinTones}
            chimes={data.chimes}
            toneBusy={busy === lvl}
            toneError={levelError[lvl]}
            toggling={!!priority && savingId === priority}
            saveError={priority ? saveError[priority] : undefined}
            preview={priority ? preview[priority] : undefined}
            onAssign={(v) => void assign(lvl, v)}
            onPreviewTone={() => void previewAssigned(lvl, data.assignments[lvl])}
            onToggle={() => { if (row) toggle(row); }}
            onPreviewSpoken={(t) => { if (row) void runPreview(row, t); }}
          />
        );
      })}

      {/* ─── GLOBAL: tone library + upload ──────────────────────────── */}
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
                  <span className="text-[10px] text-accent shrink-0">in use: {usedBy.map((l) => data.levelLabels[l] ?? l).join(', ')}</span>
                )}
                <button type="button" className="badge badge-muted hover:bg-muted/20 transition-colors"
                  onClick={() => void playUrl(apiUrl(`chimes/${c.id}.wav`))}>▶ Preview</button>
                <button type="button" className="badge badge-bad hover:bg-bad/25 transition-colors disabled:opacity-50"
                  disabled={busy === c.id} onClick={() => void remove(c.id)}>{busy === c.id ? '…' : 'Delete'}</button>
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
