import { useState } from 'react';
import type { MaintenanceWindowView } from '../types';
import { apiUrl } from '../api';
import { UI } from '../theme';
import { fmtHHMMIn } from '../siteTime';
import { useSiteTimeZone } from '../useSiteTimeZone';

/**
 * v1.197.0 — a Core's maintenance window, on its card (server maintenanceWindow.ts).
 *
 * Idle: "Shelve this Core's alarms…" opens the choice — 30 min, 1 h, 2 h (the default) or 4 h, an
 * optional note, and the list of what still sounds — and Confirm starts it (POST /api/maintenance).
 * Active: an amber strip with the end, the time left, what it has held, and End now
 * (POST /api/maintenance/end). The Core's own alerts stay on screen, marked shelved; they are not
 * pushed or announced until the window ends, when whatever is still active is.
 */

// The server's MAINT_CHOICES_MIN, MAINT_DEFAULT_MS and STILL_SOUNDS, copied: server/test/maintenanceWebMirror
// pins each literal here to the server's.
const CHOICES: ReadonlyArray<{ minutes: number; label: string }> = [
  { minutes: 30, label: '30 min' },
  { minutes: 60, label: '1 h' },
  { minutes: 120, label: '2 h' },
  { minutes: 240, label: '4 h' },
];
const DEFAULT_MINUTES = 120;

/** The server's STILL_SOUNDS (the start push carries the same list). */
const STILL_SOUNDS: readonly string[] = [
  'the reserve floor and near-reserve alarms',
  'the runway',
  'the battery-level ladder',
  'the reserve-alarm and telemetry blind alarms',
  'grid loss and every other plant-level alarm',
  'an overheating pack, a cell at the over-voltage line or a confirmed-defective pack on this Core',
];

function fmtLeft(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  const h = Math.floor(m / 60);
  return h > 0 ? `${h} h ${m % 60} m` : `${m} m`;
}

export function MaintenanceControl({ sn, label, window: w }: { sn: string; label: string; window: MaintenanceWindowView | undefined }) {
  const zone = useSiteTimeZone();
  const [open, setOpen] = useState(false);
  const [minutes, setMinutes] = useState(DEFAULT_MINUTES);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const post = async (path: string, body: Record<string, unknown>): Promise<boolean> => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch(apiUrl(path), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, source: 'web' }),
      });
      const j = (await r.json().catch(() => null)) as { error?: string } | null;
      if (!r.ok) setMsg(j?.error ?? `failed (HTTP ${r.status})`);
      return r.ok;
    } catch {
      setMsg('failed — network error');
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (w) {
    const until = fmtHHMMIn(w.untilMs, zone);
    const endNow = async () => {
      if (!window.confirm(`End ${label}'s maintenance window now? Whatever is still active on it is pushed and announced.`)) return;
      await post('api/maintenance/end', { sn });
    };
    return (
      <div className="mb-3 rounded-sm border px-2 py-1.5 text-xs flex flex-wrap items-center gap-x-2 gap-y-1"
        style={{ borderColor: UI.warn, color: UI.warn }}>
        <span className="font-semibold">MAINTENANCE</span>
        <span>— alarms shelved{until ? ` until ${until}` : ''} ({fmtLeft(w.remainingMs)} left)</span>
        <span>· {w.heldCount} held{w.heldCritical > 0 ? ` (${w.heldCritical} critical)` : ''}</span>
        {w.note ? <span className="text-muted">· {w.note}</span> : null}
        <button onClick={endNow} disabled={busy} className="ml-auto shrink-0 px-2 py-0.5 rounded-sm border border-line bg-panel hover:bg-panel2 text-ink disabled:opacity-50">
          End now
        </button>
        {msg ? <span className="basis-full" style={{ color: UI.bad }}>{msg}</span> : null}
      </div>
    );
  }

  if (!open) {
    return (
      <div className="mb-3">
        <button onClick={() => setOpen(true)} className="text-xs px-2 py-0.5 rounded-sm border border-line bg-panel hover:bg-panel2 text-muted">
          Shelve this Core's alarms…
        </button>
      </div>
    );
  }

  const confirm = async () => {
    const ok = await post('api/maintenance', { sn, minutes, note: note.trim() || undefined });
    if (ok) { setOpen(false); setNote(''); setMinutes(DEFAULT_MINUTES); }
  };
  return (
    <div className="mb-3 rounded-sm border border-line bg-panel2/50 p-2 text-xs space-y-2">
      <div className="font-semibold">Shelve {label}'s own alarms for</div>
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Window length">
        {CHOICES.map((c) => (
          <button key={c.minutes} role="radio" aria-checked={minutes === c.minutes} onClick={() => setMinutes(c.minutes)}
            className={`px-2 py-0.5 rounded-sm border ${minutes === c.minutes ? 'border-ink text-ink font-semibold' : 'border-line text-muted'} bg-panel`}>
            {c.label}
          </button>
        ))}
      </div>
      <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={80} placeholder="Note (optional), e.g. pack swap"
        className="w-full px-2 py-1 rounded-sm border border-line bg-panel text-ink" />
      <div className="text-muted">
        Its alerts stay on screen, marked shelved, and are neither pushed nor announced until the window ends — or once
        the Core has been back to normal for 15 minutes. Whatever is still active then is pushed and announced.
      </div>
      <div className="text-muted">
        <span className="font-semibold">Still sounds:</span> {STILL_SOUNDS.join('; ')}.
      </div>
      <div className="flex gap-2">
        <button onClick={confirm} disabled={busy} className="px-2 py-0.5 rounded-sm border border-line bg-panel hover:bg-panel2 text-ink disabled:opacity-50">
          Confirm
        </button>
        <button onClick={() => { setOpen(false); setMsg(null); }} disabled={busy} className="px-2 py-0.5 rounded-sm border border-line bg-panel hover:bg-panel2 text-muted">
          Cancel
        </button>
      </div>
      {msg ? <div style={{ color: UI.bad }}>{msg}</div> : null}
    </div>
  );
}
