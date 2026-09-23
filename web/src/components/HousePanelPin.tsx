import { useState } from 'react';
import type { FleetSnapshot } from '../types';
import { apiUrl } from '../api';
import { UI } from '../theme';

/**
 * v1.185.0 — shown only while two smart panels stand with none pinned as the HOUSE panel: night
 * charge writes only to the house panel, so its supervised writes are refused until one is chosen.
 * A plant that already had one panel pinned itself on first sight and never shows this.
 */
export function HousePanelPin({ state }: { state: FleetSnapshot['housePanel'] }) {
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!state?.ambiguous && !state?.missing) return null;
  const pin = async (sn: string, name: string) => {
    if (!window.confirm(`Pin ${name} as the house panel? Night charge will write its reserve and force-charge to this panel only.`)) return;
    setBusy(true);
    try {
      const r = await fetch(apiUrl('api/house-panel'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sn }),
      });
      const j = (await r.json().catch(() => null)) as { error?: string } | null;
      setMsg(r.ok ? null : j?.error ?? `pin failed (HTTP ${r.status})`);
    } catch {
      setMsg('pin failed — network error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card col-span-full flex flex-wrap items-center gap-3 text-sm">
      <span style={{ color: UI.muted }}>
        {state.missing
          ? `The pinned house panel (${state.missing}) is not on the account — night-charge writes are paused until it returns or another panel is chosen.`
          : 'Two smart panels and none pinned as the house panel — night-charge writes are paused until one is chosen.'}
      </span>
      {state.panels.map((p) => (
        <button key={p.sn} onClick={() => pin(p.sn, p.name)} disabled={busy} className="shrink-0 px-2 py-1 rounded border border-line bg-panel hover:bg-panel2 text-ink disabled:opacity-50">
          {p.name} is the house panel
        </button>
      ))}
      {msg ? <span className="text-xs" style={{ color: UI.bad }}>{msg}</span> : null}
    </div>
  );
}
