import { useCallback, useEffect, useState } from 'react';
import { apiUrl } from '../api';

/**
 * v1.135.0 — refresh the published database snapshot.
 *
 * The live database is add-on-private (`/data/ecoflow.db`), so nothing outside
 * the container — SQLite Web, a laptop, a backup script — can read it. The
 * add-on copies it to `/share/ecoflow-panel/` on request, and that copy is a
 * SNAPSHOT, not a mirror: it changes only when someone asks.
 *
 * That is exactly how it went stale. The export was run once on 2026-08-23 and
 * then browsed two weeks later as though it were live, missing every night in
 * between. Identical created/modified timestamps were the only tell. This button
 * exists so refreshing it is a click rather than a recipe, and — more usefully —
 * so the AGE of the snapshot is visible without having to go and look.
 *
 * The copy is ~1.7 GB and takes ~20-30 s. The button therefore states the size
 * before you commit to it, and reports what actually landed rather than assuming
 * the write succeeded.
 */

interface ExportStatus {
  ok: boolean;
  exists?: boolean;
  path?: string;
  bytes?: number;
  modifiedAt?: string;
  inProgress?: boolean;
  sourcePath?: string;
}

interface ExportResult {
  ok: boolean;
  path?: string;
  bytes?: number;
  sourceBytes?: number;
  elapsedMs?: number;
  generatedAt?: string;
  error?: string;
  message?: string;
}

const gb = (b?: number) => (b == null ? '—' : `${(b / 1e9).toFixed(2)} GB`);

/** Humanised age, and whether it is old enough to be misleading. */
function describeAge(iso?: string): { text: string; stale: boolean } {
  if (!iso) return { text: 'never exported', stale: true };
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return { text: 'unknown age', stale: true };
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return { text: `${mins} min old`, stale: false };
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return { text: `${hrs} h old`, stale: hrs >= 12 };
  const days = Math.floor(hrs / 24);
  return { text: `${days} day${days === 1 ? '' : 's'} old`, stale: true };
}

export function DbExportButton() {
  const [status, setStatus] = useState<ExportStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ExportResult | null>(null);
  const [confirming, setConfirming] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch(apiUrl('api/db-export'));
      if (r.ok) setStatus(await r.json());
    } catch { /* status is optional UX — the button still works */ }
  }, []);

  useEffect(() => { load(); }, [load]);

  const onConfirm = async () => {
    setConfirming(false);
    setBusy(true);
    setResult(null);
    try {
      const r = await fetch(apiUrl('api/db-export'), { method: 'POST' });
      const j = (await r.json()) as ExportResult;
      // Do NOT trust the HTTP status alone — report what the body says landed.
      setResult(r.ok ? j : { ok: false, message: j.error ?? j.message ?? `HTTP ${r.status}` });
      await load();
    } catch (e: any) {
      setResult({ ok: false, message: String(e?.message ?? e) });
    } finally {
      setBusy(false);
    }
  };

  const age = describeAge(status?.modifiedAt);
  const running = busy || status?.inProgress === true;

  return (
    <div className="bg-panel2/60 border border-line rounded-xl p-3">
      <div className="text-[10px] uppercase tracking-widest text-muted">Database snapshot</div>
      <div className="text-sm mt-1 flex items-baseline gap-2 flex-wrap">
        {status?.exists === false ? (
          <span className="text-muted">not exported yet</span>
        ) : (
          <>
            <span className="tabular-nums">{gb(status?.bytes)}</span>
            <span className={age.stale ? 'text-warn text-xs' : 'text-muted text-xs'}>{age.text}</span>
          </>
        )}
      </div>
      <div className="text-[10px] text-muted mt-1 leading-tight">
        A copy, not a live mirror — it only changes when refreshed.
      </div>

      <button
        type="button"
        disabled={running}
        onClick={() => setConfirming(true)}
        className={`badge text-[10px] mt-2 ${running ? 'badge-muted opacity-60 cursor-not-allowed' : 'badge-ok hover:bg-ok/25'}`}
        title={running ? 'An export is already running.' : 'Copy the live database to /share/ecoflow-panel/ so SQLite Web and backups can read it.'}
      >
        {running ? 'exporting…' : 'Refresh snapshot'}
      </button>

      {result && !result.ok && (
        <div className="text-[10px] text-bad mt-1 leading-tight">✕ {result.message ?? 'export failed'}</div>
      )}
      {result?.ok && (
        <div className="text-[10px] text-ok mt-1 leading-tight">
          ✓ {gb(result.bytes)} written in {((result.elapsedMs ?? 0) / 1000).toFixed(1)} s
        </div>
      )}

      {confirming && (
        <div
          className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4"
          onClick={() => setConfirming(false)}
          role="dialog"
        >
          <div className="bg-panel border border-line rounded-lg p-5 max-w-md w-full" onClick={(e) => e.stopPropagation()}>
            <div className="text-base font-semibold mb-2">Refresh the database snapshot?</div>
            <p className="text-sm text-muted mb-1 leading-relaxed">
              Copies the live database to{' '}
              <span className="font-mono text-xs">{status?.path ?? '/share/ecoflow-panel/'}</span>, overwriting
              the existing snapshot. Roughly {gb(status?.bytes)}, about 20–30 seconds.
            </p>
            <p className="text-xs text-muted leading-relaxed">
              Read-only with respect to the live database — it copies, never modifies. Do this before
              browsing the data in SQLite Web, or the ledger you read will be as old as the last export.
            </p>
            <div className="flex justify-end gap-2 mt-4">
              <button type="button" className="badge badge-muted" onClick={() => setConfirming(false)}>Cancel</button>
              <button type="button" className="badge badge-ok" onClick={onConfirm}>Refresh</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
